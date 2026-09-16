"use client";

// /keeperhub: the execution layer. KeeperCard decides what may be spent; this page is
// the record of KeeperHub actually moving it — workflows, runs, step logs, tx hashes.
// Read-only: nothing on this page moves money, it only reports what already did.

import { useCallback } from "react";
import { useRemit } from "../useRemit";
import { Cockpit } from "../components/Shell";
import KeeperHubPane from "../components/KeeperHub";

export default function KeeperHubPage() {
  const remit = useRemit();
  const { address, logout, authenticated, ready } = remit;

  // The pane owns its own polling; the shell's refresh only re-checks the session.
  const refresh = useCallback(async () => {}, []);

  if (!ready) return <main className="narrow">Loading…</main>;
  if (!authenticated) {
    return (
      <main className="narrow">
        <div className="panel">
          <p className="subnote">Sign in on the dashboard first.</p>
        </div>
      </main>
    );
  }

  return (
    <Cockpit back={{ href: "/app", label: "Dashboard" }} remit={remit} refresh={refresh} onLogout={logout} address={address}>
      <div style={{ padding: "0 8px" }}>
        <h1 style={{ fontSize: 22, margin: "4px 0 14px" }}>KeeperHub</h1>
        <KeeperHubPane />
      </div>
    </Cockpit>
  );
}
