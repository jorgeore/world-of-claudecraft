// Fork (Livezul): IDLE auto-farm mode. A client-side autopilot that plays the
// character through the SAME IWorld commands the keyboard/mouse issue — the
// server stays fully authoritative (this can never do anything a human with a
// keyboard could not). State machine: scan → approach → combat → loot →
// (rest | return | wander) → scan; dead → release + spirit-healer resurrect.
//
// Design notes:
//  - Movement is supplied through resolveMove() (main.ts's resolveMove defers
//    to it while active), mirroring how the keyboard fills world.moveInput.
//    Direction/facing are recomputed EVERY frame from live entity positions;
//    update() only makes decisions on a jittered ~4Hz cadence.
//  - Targets and loot are leashed to the anchor point captured when the mode
//    was enabled, so the character farms the area the player parked it in.
//  - Straight-line approach with a stuck detector: no progress for a few
//    seconds blacklists the target and rescans (cheap, no pathfinding in v1).
//  - Any manual movement key or click-move cancels the mode (main.ts hook).
import { isAttackableEntity } from '../game/interactions';
import { dist2d, type Entity, INTERACT_RANGE, type MoveInput } from '../sim/types';
import type { IWorld } from '../world_api';

const TARGET_SCAN_RADIUS = 40; // same reach as the mobile attack-nearest button
const LEASH_RADIUS = 45; // farm only this far from the anchor
const MELEE_STOP = 3.0; // approach stop distance (melee reach)
const CHASE_SLACK = 3.0; // re-approach if the mob slips this far beyond engage range
const RANGED_MIN_ENGAGE = 8; // an offensive kit reaching at least this far = ranged class
const LOOT_SCAN_RADIUS = 30;
const LOOT_STOP = INTERACT_RANGE - 1;
const REST_ENTER_PCT = 0.4;
const REST_EXIT_PCT = 0.85;
const LEVEL_CAP_DELTA = 4; // skip mobs more than this many levels above us
const DECIDE_MIN_S = 0.2;
const DECIDE_JITTER_S = 0.15; // humanize the decision cadence a little
const STUCK_WINDOW_S = 3;
const STUCK_MIN_PROGRESS = 1.0; // world units the goal distance must shrink per window
const BLACKLIST_S = 45;
const DEATH_LIMIT = 3; // auto-disable after this many deaths...
const DEATH_WINDOW_S = 600; // ...within this window
const ATTACK_REFRESH_S = 1.5; // re-assert the auto-attack toggle while fighting
const LOOT_RETRY_S = 0.6;
const LOOT_GRACE_S = 2.0; // corpse may take a moment to flag lootable
const WANDER_AFTER_EMPTY_S = 5; // no targets for this long -> wander inside the leash

type IdleState =
  | 'off'
  | 'scan'
  | 'approach'
  | 'combat'
  | 'loot'
  | 'rest'
  | 'return'
  | 'wander'
  | 'dead';

const NO_MOVE: MoveInput = {
  forward: false,
  back: false,
  turnLeft: false,
  turnRight: false,
  strafeLeft: false,
  strafeRight: false,
  jump: false,
};

function moveForward(): MoveInput {
  return { ...NO_MOVE, forward: true };
}

export class IdleAutopilot {
  active = false;
  kills = 0;

  private state: IdleState = 'off';
  private time = 0;
  private decideTimer = 0;
  private anchor: { x: number; z: number } | null = null;
  private targetId: number | null = null;
  private lootId: number | null = null;
  private goalPoint: { x: number; z: number } | null = null;
  private statusText = 'IDLE desligado';
  private blacklist = new Map<number, number>(); // entity id -> expires (this.time)
  private deaths: number[] = []; // this.time of each death
  private wasDead = false;
  private releasedAt = 0;
  private attackRefresh = 0;
  private lootRetry = 0;
  private lootGrace = 0;
  private emptyScanFor = 0;
  private stuckTimer = 0;
  private stuckStartDist = Number.POSITIVE_INFINITY;
  // Engagement distance derived from the class kit: melee reach for warriors,
  // just inside the longest offensive ability range for casters/hunters — so a
  // mage opens with a bolt from afar instead of strolling into punch range.
  private engageDist = MELEE_STOP;

  constructor(private world: IWorld) {}

  status(): string {
    return this.statusText;
  }

  toggle(): void {
    if (this.active) this.stop('desligado');
    else this.start();
  }

  start(): void {
    const p = this.world.player;
    this.active = true;
    this.kills = 0;
    this.anchor = { x: p.pos.x, z: p.pos.z };
    this.blacklist.clear();
    this.deaths = [];
    this.wasDead = p.dead;
    this.emptyScanFor = 0;
    this.enter('scan');
    this.statusText = 'IDLE: ativado';
  }

  stop(reason: string): void {
    if (!this.active && this.state === 'off') return;
    this.active = false;
    this.state = 'off';
    this.targetId = null;
    this.lootId = null;
    this.goalPoint = null;
    this.statusText = `IDLE: ${reason}`;
    try {
      Object.assign(this.world.moveInput, NO_MOVE);
      this.world.stopAutoAttack();
    } catch {
      /* world may be tearing down */
    }
  }

  /** Tab went hidden (OBS stays visible; a minimized tab stalls rAF): freeze
   *  movement so the server does not keep applying the last direction. */
  onHidden(): void {
    if (!this.active) return;
    this.goalPoint = null;
    Object.assign(this.world.moveInput, NO_MOVE);
  }

  /** Movement supplier while active — called from main.ts resolveMove every
   *  frame. Recomputes direction/facing live so moving targets are tracked. */
  resolveMove(
    playerPos: { x: number; z: number },
    _playerFacing: number,
  ): { mi: MoveInput; facing: number | null } {
    const follow = (goal: { x: number; z: number }, stopDist: number, moveWhenFar: boolean) => {
      const dx = goal.x - playerPos.x;
      const dz = goal.z - playerPos.z;
      const d = Math.hypot(dx, dz);
      const facing = Math.atan2(dx, dz);
      const mi = moveWhenFar && d > stopDist ? moveForward() : { ...NO_MOVE };
      return { mi, facing };
    };
    // Moving cancels casts (castWhileMoving is rare) — while a cast bar is up,
    // stand still no matter what the state wants.
    const casting = !!this.world.player.castingAbility;
    switch (this.state) {
      case 'approach': {
        const t = this.targetId !== null ? this.world.entities.get(this.targetId) : undefined;
        if (t) return follow({ x: t.pos.x, z: t.pos.z }, this.engageDist, !casting);
        break;
      }
      case 'combat': {
        const t = this.targetId !== null ? this.world.entities.get(this.targetId) : undefined;
        // Face the target always; step forward only if it slipped well beyond
        // our engagement range (and never while casting).
        if (t) {
          const d = dist2d(playerPos as Entity['pos'], t.pos);
          return follow(
            { x: t.pos.x, z: t.pos.z },
            this.engageDist,
            !casting && d > this.engageDist + CHASE_SLACK,
          );
        }
        break;
      }
      case 'loot': {
        const c = this.lootId !== null ? this.world.entities.get(this.lootId) : undefined;
        if (c) return follow({ x: c.pos.x, z: c.pos.z }, LOOT_STOP, true);
        break;
      }
      case 'return':
      case 'wander': {
        if (this.goalPoint) return follow(this.goalPoint, 4, true);
        break;
      }
      default:
        break;
    }
    return { mi: { ...NO_MOVE }, facing: null };
  }

  update(dt: number): void {
    if (!this.active) return;
    this.time += dt;
    this.decideTimer -= dt;
    this.trackStuck(dt);
    if (this.decideTimer > 0) return;
    this.decideTimer = DECIDE_MIN_S + Math.random() * DECIDE_JITTER_S;

    const p = this.world.player;
    this.engageDist = this.computeEngageDist();

    // ── death loop ──────────────────────────────────────────────────────────
    if (p.dead || p.ghost) {
      if (!this.wasDead) {
        this.wasDead = true;
        this.deaths.push(this.time);
        this.deaths = this.deaths.filter((t) => this.time - t < DEATH_WINDOW_S);
        if (this.deaths.length >= DEATH_LIMIT) {
          this.stop(`parado: morreu ${DEATH_LIMIT}x — área perigosa demais`);
          return;
        }
      }
      this.enter('dead');
      this.statusText = 'IDLE: morto, renascendo…';
      // Release once, then take the spirit-healer resurrect (the RL bots do the
      // same — no corpse-run policy). Small spacing between the two commands.
      if (this.time - this.releasedAt > 1.5) {
        this.releasedAt = this.time;
        if (!p.ghost) this.world.releaseSpirit();
        else this.world.resurrectAtSpiritHealer();
      }
      return;
    }
    if (this.wasDead) {
      // Just revived (possibly at a distant graveyard): walk back to the farm.
      this.wasDead = false;
      this.enter(this.distToAnchor(p) > LEASH_RADIUS ? 'return' : 'scan');
      if (this.state === 'return' && this.anchor) this.goalPoint = { ...this.anchor };
    }

    // ── being attacked overrides everything except death ────────────────────
    if (p.inCombat && (this.state === 'rest' || this.state === 'return' || this.state === 'wander' || this.state === 'scan')) {
      const attacker = this.findAttacker(p);
      if (attacker) {
        this.targetId = attacker.id;
        this.world.targetEntity(attacker.id);
        this.enter('combat');
      }
    }

    switch (this.state) {
      case 'scan': {
        if (p.hp / Math.max(1, p.maxHp) < REST_ENTER_PCT && !p.inCombat) {
          this.enter('rest');
          break;
        }
        const corpse = this.findLootable(p);
        if (corpse) {
          this.lootId = corpse.id;
          this.lootGrace = 0;
          this.enter('loot');
          break;
        }
        const tgt = this.findTarget(p);
        if (tgt) {
          this.emptyScanFor = 0;
          this.targetId = tgt.id;
          this.world.targetEntity(tgt.id);
          this.enter('approach');
          this.statusText = `IDLE: indo até ${tgt.name}`;
          break;
        }
        this.emptyScanFor += DECIDE_MIN_S;
        this.statusText = 'IDLE: procurando alvos…';
        if (this.distToAnchor(p) > LEASH_RADIUS * 0.7 && this.anchor) {
          this.goalPoint = { ...this.anchor };
          this.enter('return');
        } else if (this.emptyScanFor > WANDER_AFTER_EMPTY_S && this.anchor) {
          const a = Math.random() * Math.PI * 2;
          const r = 12 + Math.random() * (LEASH_RADIUS - 15);
          this.goalPoint = {
            x: this.anchor.x + Math.sin(a) * r,
            z: this.anchor.z + Math.cos(a) * r,
          };
          this.emptyScanFor = 0;
          this.enter('wander');
          this.statusText = 'IDLE: explorando a área…';
        }
        break;
      }

      case 'approach': {
        const t = this.liveTarget();
        if (!t) {
          this.enter('scan');
          break;
        }
        if (dist2d(p.pos, t.pos) <= this.engageDist + 0.2) {
          this.enter('combat');
          // Auto-attack toggles on regardless of distance: for melee weapons an
          // out-of-range swing is a silent no-op, for hunters/wands the auto IS
          // the ranged shot — one toggle covers both kits.
          this.world.startAutoAttack();
          this.attackRefresh = this.time;
        }
        break;
      }

      case 'combat': {
        const t = this.targetId !== null ? this.world.entities.get(this.targetId) : undefined;
        if (!t || (t.dead && !t.lootable)) {
          if (t?.dead) this.kills++;
          this.targetId = null;
          this.enter('scan');
          break;
        }
        if (t.dead) {
          this.kills++;
          this.lootId = t.id;
          this.lootGrace = 0;
          this.targetId = null;
          this.enter('loot');
          break;
        }
        if (this.time - this.attackRefresh > ATTACK_REFRESH_S) {
          this.attackRefresh = this.time;
          this.world.startAutoAttack();
        }
        this.castSomethingUseful(p, t);
        const ranged = this.engageDist > MELEE_STOP + 1;
        this.statusText = `IDLE: atacando ${t.name}${ranged ? ' à distância' : ''} (${this.kills} abates)`;
        break;
      }

      case 'loot': {
        const c = this.lootId !== null ? this.world.entities.get(this.lootId) : undefined;
        if (!c) {
          this.lootId = null;
          this.enter('scan');
          break;
        }
        if (!c.lootable) {
          // The corpse may take a beat to flag lootable — wait a short grace.
          this.lootGrace += DECIDE_MIN_S;
          if (this.lootGrace > LOOT_GRACE_S) {
            this.lootId = null;
            this.enter('scan');
          }
          break;
        }
        this.statusText = 'IDLE: saqueando…';
        if (dist2d(p.pos, c.pos) <= LOOT_STOP + 0.3 && this.time - this.lootRetry > LOOT_RETRY_S) {
          this.lootRetry = this.time;
          this.world.autoLoot(c.id);
        }
        break;
      }

      case 'rest': {
        const pct = p.hp / Math.max(1, p.maxHp);
        this.statusText = `IDLE: descansando (${Math.round(pct * 100)}%)`;
        if (p.inCombat) {
          const attacker = this.findAttacker(p);
          if (attacker) {
            this.targetId = attacker.id;
            this.world.targetEntity(attacker.id);
            this.enter('combat');
          }
          break;
        }
        if (pct >= REST_EXIT_PCT) this.enter('scan');
        break;
      }

      case 'return': {
        this.statusText = 'IDLE: voltando para a área…';
        if (!this.goalPoint || this.distToPoint(p, this.goalPoint) < 5) {
          this.goalPoint = null;
          this.enter('scan');
        }
        break;
      }

      case 'wander': {
        if (!this.goalPoint || this.distToPoint(p, this.goalPoint) < 5) {
          this.goalPoint = null;
          this.enter('scan');
        }
        // Opportunistic: a target appearing mid-wander interrupts the stroll.
        const tgt = this.findTarget(p);
        if (tgt) {
          this.goalPoint = null;
          this.targetId = tgt.id;
          this.world.targetEntity(tgt.id);
          this.enter('approach');
        }
        break;
      }

      default:
        this.enter('scan');
        break;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private enter(state: IdleState): void {
    if (this.state !== state) {
      this.state = state;
      this.stuckTimer = 0;
      this.stuckStartDist = Number.POSITIVE_INFINITY;
    }
  }

  private liveTarget(): Entity | undefined {
    const t = this.targetId !== null ? this.world.entities.get(this.targetId) : undefined;
    if (!t || t.dead || !t.hostile) {
      this.targetId = null;
      return undefined;
    }
    return t;
  }

  private findTarget(p: Entity): Entity | null {
    let best: Entity | null = null;
    let bestD = TARGET_SCAN_RADIUS;
    for (const e of this.world.entities.values()) {
      if (!isAttackableEntity(e, this.world.playerId)) continue;
      if (e.level > p.level + LEVEL_CAP_DELTA) continue;
      const bl = this.blacklist.get(e.id);
      if (bl !== undefined && bl > this.time) continue;
      if (this.anchor && dist2d({ x: this.anchor.x, y: 0, z: this.anchor.z } as Entity['pos'], e.pos) > LEASH_RADIUS)
        continue;
      const d = dist2d(p.pos, e.pos);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  private findLootable(p: Entity): Entity | null {
    let best: Entity | null = null;
    let bestD = LOOT_SCAN_RADIUS;
    for (const e of this.world.entities.values()) {
      if (e.kind !== 'mob' || !e.lootable) continue;
      const d = dist2d(p.pos, e.pos);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  private findAttacker(p: Entity): Entity | null {
    let best: Entity | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const e of this.world.entities.values()) {
      if (e.kind !== 'mob' || e.dead || !e.hostile) continue;
      if (e.targetId !== p.id) continue;
      const d = dist2d(p.pos, e.pos);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  /** Offensive, directly-castable abilities of the kit: enemy-targeted (the
   *  targetType default), no ground aiming, no form/proc preconditions. */
  private offensiveAbilities(): { id: string; range: number; minRange: number; cost: number; offGcd: boolean; hpBelow?: number }[] {
    const out: { id: string; range: number; minRange: number; cost: number; offGcd: boolean; hpBelow?: number }[] = [];
    for (const known of this.world.known) {
      const def = known.def;
      if (!def) continue;
      if (def.targetMode === 'position') continue;
      if ((def.targetType ?? 'enemy') !== 'enemy') continue;
      if (!def.requiresTarget) continue;
      if (def.requiresForm || def.requiresDodgeProc) continue;
      out.push({
        id: def.id,
        range: def.range ?? 0,
        minRange: def.minRange ?? 0,
        cost: known.cost,
        offGcd: !!def.offGcd,
        hpBelow: def.requiresTargetHpBelow,
      });
    }
    return out;
  }

  /** Melee reach for a melee kit; just inside the longest offensive ability
   *  range for a ranged kit (mage/hunter/warlock), so pulls open from afar. */
  private computeEngageDist(): number {
    let maxRange = 0;
    for (const a of this.offensiveAbilities()) maxRange = Math.max(maxRange, a.range);
    if (maxRange < RANGED_MIN_ENGAGE) return MELEE_STOP;
    return Math.max(RANGED_MIN_ENGAGE, maxRange - 2);
  }

  /** Cast the first ready ability that can legally hit the target from HERE
   *  (readiness formula from the RL encoder + range/minRange/execute checks).
   *  Never starts a cast while one is already running. */
  private castSomethingUseful(p: Entity, target: Entity): void {
    if (p.castingAbility) return;
    const dist = dist2d(p.pos, target.pos);
    for (const a of this.offensiveAbilities()) {
      const inRange = a.range === 0 ? dist <= MELEE_STOP + 0.5 : dist <= a.range - 0.3 && dist >= a.minRange + 0.2;
      if (!inRange) continue;
      if (a.hpBelow !== undefined && target.hp / Math.max(1, target.maxHp) > a.hpBelow) continue;
      const cd = p.cooldowns.get(a.id) ?? 0;
      const ready = cd <= 0 && p.resource >= a.cost && (a.offGcd || p.gcdRemaining <= 0);
      if (!ready) continue;
      this.world.castAbility(a.id);
      break;
    }
  }

  private distToAnchor(p: Entity): number {
    if (!this.anchor) return 0;
    return this.distToPoint(p, this.anchor);
  }

  private distToPoint(p: Entity, g: { x: number; z: number }): number {
    return Math.hypot(g.x - p.pos.x, g.z - p.pos.z);
  }

  /** No goal-distance progress for a few seconds while moving = stuck on
   *  geometry: blacklist the target (if any) and rescan somewhere else. */
  private trackStuck(dt: number): void {
    const moving = this.state === 'approach' || this.state === 'loot' || this.state === 'return' || this.state === 'wander';
    if (!moving) return;
    const p = this.world.player;
    let goal: { x: number; z: number } | null = null;
    if (this.state === 'approach' && this.targetId !== null) {
      const t = this.world.entities.get(this.targetId);
      if (t) goal = { x: t.pos.x, z: t.pos.z };
    } else if (this.state === 'loot' && this.lootId !== null) {
      const c = this.world.entities.get(this.lootId);
      if (c) goal = { x: c.pos.x, z: c.pos.z };
    } else {
      goal = this.goalPoint;
    }
    if (!goal) return;
    const d = this.distToPoint(p, goal);
    this.stuckTimer += dt;
    // Capture the distance once per window (NOT a running min — tracking the
    // min would measure progress-from-best and flag steady approach as stuck).
    if (this.stuckStartDist === Number.POSITIVE_INFINITY) this.stuckStartDist = d;
    if (this.stuckTimer >= STUCK_WINDOW_S) {
      if (this.stuckStartDist !== Number.POSITIVE_INFINITY && this.stuckStartDist - d < STUCK_MIN_PROGRESS && d > MELEE_STOP + 1) {
        if (this.targetId !== null) this.blacklist.set(this.targetId, this.time + BLACKLIST_S);
        if (this.lootId !== null) this.blacklist.set(this.lootId, this.time + BLACKLIST_S);
        this.targetId = null;
        this.lootId = null;
        this.goalPoint = null;
        this.enter('scan');
        this.statusText = 'IDLE: preso no caminho, trocando de alvo…';
      }
      this.stuckTimer = 0;
      this.stuckStartDist = d;
    }
  }
}
