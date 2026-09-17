// The SDK against the REAL server app: every namespace makes at least one call,
// errors map to KeeperCardError with the typed refusal code, and the webhook
// verifier agrees with the server's own signer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyedMutex, Store, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "@attestpay/server/src/app";
import type { AppDeps } from "@attestpay/server/src/deps";
import { EventBus } from "@attestpay/server/src/events/bus";
import { EventStore } from "@attestpay/server/src/events/store";
import { signWebhook } from "@attestpay/server/src/events/deliver";
import { TeamStore } from "@attestpay/server/src/teams/store";
import { KeeperCard, KeeperCardError, verifyWebhookSignature } from "../src/index";

const ADMIN = "sdk-admin";
const user = privateKeyToAccount(generatePrivateKey());
const USER_ID = user.address.toLowerCase();

let server: ReturnType<typeof Bun.serve>;
let store: Store;
let kc: KeeperCard;
let cardId: string;

const fakeRelayer = {
  getFeeData: async () => ({ minFee: "0.01", rate: 1, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a", context: "ctx" }),
  estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
  send: async () => "0xreq",
  getStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null }),
  waitForStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null, timedOut: false }),
};

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "b".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL = "1";
  store = new Store(":memory:");
  const deps: AppDeps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: user,
    adminToken: ADMIN,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
    events: new EventBus(new EventStore(store.db), store),
    teams: new TeamStore(store.db),
  };
  store.upsertUser({ id: USER_ID, address: user.address });
  const issued = await issueRootCard({ store, userSigner: user, revocationNonceOverride: 0n }, { userId: USER_ID, name: "sdk card", terms: { pay: { period: { amount: "10.00", seconds: 604800 } } } });
  cardId = issued.cardId;
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  kc = new KeeperCard({ baseUrl: `http://localhost:${server.port}`, token: ADMIN, userId: USER_ID });
});

afterAll(() => {
  server?.stop(true);
  store?.close();
  delete process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL;
});

describe("client", () => {
  test("cards: list, get, freeze, unfreeze", async () => {
    const list = await kc.cards.list();
    expect(list.map((c) => c.card_id)).toEqual([cardId]);
    const d = await kc.cards.get(cardId);
    expect(d.name).toBe("sdk card");
    expect((await kc.cards.freeze(cardId)).status).toBe("frozen");
    expect((await kc.cards.unfreeze(cardId)).status).toBe("active");
  });

  test("errors carry the typed refusal", async () => {
    const e = await kc.cards.get("nope").catch((x) => x as KeeperCardError);
    expect(e).toBeInstanceOf(KeeperCardError);
    expect((e as KeeperCardError).status).toBe(422);
    expect((e as KeeperCardError).code).toBe("card_not_found");
  });

  test("keeperhub status is readable when unwired, and the rest refuses cleanly", async () => {
    const s = await kc.keeperhub.status();
    expect(s.enabled).toBe(false);
    const e = await kc.keeperhub.workflows().catch((x) => x as KeeperCardError);
    expect(e).toBeInstanceOf(KeeperCardError);
  });

  test("webhooks, events, audit, alerts and teams round-trip", async () => {
    const w = await kc.webhooks.create({ url: "http://localhost:9/x", events: ["card.frozen"] });
    expect(w.secret).toMatch(/^whsec_/);
    expect((await kc.webhooks.list()).items).toHaveLength(1);
    expect((await kc.webhooks.deliveries(w.webhook_id)).items).toHaveLength(0);
    await kc.cards.freeze(cardId);
    expect((await kc.webhooks.deliveries(w.webhook_id)).items).toHaveLength(1);
    await kc.cards.unfreeze(cardId);
    expect((await kc.webhooks.delete(w.webhook_id)).deleted).toBe(true);

    const evs = await kc.events.list({ card_id: cardId });
    expect(evs.items.some((e) => e.type === "card.frozen")).toBe(true);
    const audit = await kc.audit.list({ card_id: cardId });
    expect(audit.items.some((a) => a.action === "card.frozen")).toBe(true);
    const csv = await kc.audit.csv({ card_id: cardId });
    expect(csv.split("\n")[0]).toContain("actor_kind");

    expect((await kc.alerts.set(cardId, 35)).threshold_pct).toBe(35);
    expect((await kc.alerts.get(cardId)).threshold_pct).toBe(35);

    const t = await kc.teams.create("sdk team");
    expect(t.your_role).toBe("owner");
    await kc.teams.addMember(t.team_id, { address: privateKeyToAccount(generatePrivateKey()).address, role: "viewer" });
    expect((await kc.teams.get(t.team_id)).members).toHaveLength(2);
    expect((await kc.cards.assignTeam(cardId, t.team_id)).team?.name).toBe("sdk team");
    expect((await kc.cards.get(cardId)).team?.team_id).toBe(t.team_id);
    await kc.cards.assignTeam(cardId, null);
    expect((await kc.teams.delete(t.team_id)).deleted).toBe(true);
  });

  test("a Privy-style token function is called per request", async () => {
    let calls = 0;
    const client = new KeeperCard({ baseUrl: `http://localhost:${server.port}`, token: async () => (calls++, ADMIN), userId: USER_ID });
    await client.cards.list();
    await client.cards.list();
    expect(calls).toBe(2);
  });
});

describe("verifiers", () => {
  test("webhook signature verification matches the server's signer", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "card.frozen" });
    const header = signWebhook("whsec_abc", 1_757_000_000, body);
    expect(await verifyWebhookSignature("whsec_abc", header, body, { now: 1_757_000_005 })).toBe(true);
    expect(await verifyWebhookSignature("whsec_abc", header, body + " ", { now: 1_757_000_005 })).toBe(false);
    expect(await verifyWebhookSignature("whsec_abc", header, body, { now: 1_757_009_000 })).toBe(false);
  });
});
