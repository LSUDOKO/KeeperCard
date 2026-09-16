// Pin the test environment before any module reads it.
//
// chains.ts resolves CHAIN_ID once at import time, and the suite asserts against
// Base (8453) addresses throughout. A developer .env that targets Base Sepolia
// would otherwise fail ~20 tests that have nothing to do with their change.
//
// Same reasoning for the KeeperHub keys: tests drive the executor through injected
// fakes, so a real key in .env must not leak into them and reach the live API.
process.env.ATTESTPAY_CHAIN_ID = "8453";

for (const key of ["KEEPERHUB_API_KEY", "KEEPERHUB_WALLET_ADDRESS", "KEEPERHUB_HOOK_SECRET"]) {
  delete process.env[key];
}
