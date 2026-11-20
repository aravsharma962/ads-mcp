/** "123", "ACT_123" and " act_123 " all become "act_123"; anything else is null. */
export function normAccount(raw: string): string | null {
  const digits = raw.trim().replace(/^act_/i, "");
  return /^\d{1,30}$/.test(digits) ? `act_${digits}` : null;
}
