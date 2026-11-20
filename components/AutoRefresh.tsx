"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server component every few seconds so new requests show up live.
export default function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [on, intervalMs, router]);

  return (
    <label className="small" style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: 0 }}>
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Live
    </label>
  );
}
