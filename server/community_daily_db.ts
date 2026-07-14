// Community daily reward persistence (SQL only; fork feature). One row per
// (account, day, realm) is the account-wide once-per-day guard for the Livezul
// daily chest: the INSERT is the atomic first-caller-wins claim (mirrors the
// daily_rewards_db idempotent-claim pattern), and the row doubles as an
// append-only audit of what was granted. Takes the shared `pool` argument so
// this module never imports db.ts (cycle-free, like twitch_db.ts).
import type { Pool } from 'pg';

export const COMMUNITY_DAILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_daily_claims (
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reward_day TEXT NOT NULL,
  realm TEXT NOT NULL,
  granted_copper INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, reward_day, realm)
);
`;

/**
 * Atomically claim today's community daily for an account. Returns true only
 * for the FIRST caller of the (account, day, realm) tuple — every concurrent or
 * repeat attempt sees rowCount 0 and must not grant. The claim is written
 * BEFORE the in-sim delivery on purpose: a crash between the two costs at most
 * one day's letter, while the reverse order could mint one letter per login.
 */
export async function claimCommunityDaily(
  pool: Pool,
  accountId: number,
  rewardDay: string,
  realm: string,
  grantedCopper: number,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO community_daily_claims (account_id, reward_day, realm, granted_copper)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [accountId, rewardDay, realm, Math.max(0, Math.trunc(grantedCopper))],
  );
  return res.rowCount === 1;
}
