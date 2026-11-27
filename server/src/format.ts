/** Server-side INR formatting for templated text. Digits come from data; this only formats them. */
export const inr = (n: number) =>
  "₹" +
  n.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
