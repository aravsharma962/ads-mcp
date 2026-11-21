"use client";

import { useState } from "react";

/** Copies with the Clipboard API; falls back to a hidden textarea and execCommand when it is unavailable or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

export default function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function onClick() {
    setState((await copyText(text)) ? "copied" : "failed");
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={onClick} className={`rounded border px-3 py-1 text-sm print:hidden ${className}`}>{label}</button>
      {state === "copied" && <span role="status" className="text-sm text-green-700">Copied</span>}
      {state === "failed" && <span role="alert" className="text-sm text-red-700">Could not copy. Select the text and copy it by hand.</span>}
    </span>
  );
}
