# Screenshots

Captured from the live deployment; nothing here is mocked. The README's **Proof** section
explains what each one shows.

| File | Source | Shows |
|---|---|---|
| `keeperhub-analytics.jpg` | app.keeperhub.com | Org run count, success rate, sponsored gas |
| `keeperhub-guarded-workflow-canvas.jpg` | app.keeperhub.com | `guarded-card-payment` node graph |
| `keeperhub-guarded-run-steps.jpg` | app.keeperhub.com | A real run: four green steps, gas sponsored |
| `keeperhub-treasury-scheduled-runs.jpg` | app.keeperhub.com | `treasury-monitor` fired every 10 minutes by KeeperHub |
| `keeperhub-runs-table.jpg` | app.keeperhub.com | Payment → receipt → event watcher, in KeeperHub's run table |
| `dashboard-card.jpg` | KeeperCard dashboard | The card an agent spent from, with settled payments |
| `console-*.jpg` | KeeperCard dashboard `/keeperhub` | Status, treasury, workflows, executions, receipts |
| `explorer-payment-tx.jpg` | Blockscout | A production payment: success, two USDC transfers |
| `explorer-receipt-events.jpg` | Blockscout | `PaymentAnchored` events on the receipt contract |
| `terminal-*.png` | `freeze` | `keeperhub:doctor`, `keeperhub:history`, `verify:onchain`, `bun test` |
