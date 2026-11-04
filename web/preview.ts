// Sample content shown when the page is opened with ?phase=speaking (or another phase), so the design can be seen without a call.
import type { Summary, TimelineItem } from "./useCall";

// ?id=pending previews an ID the caller has not said yes to yet.
const pending = new URLSearchParams(location.search).get("id") === "pending";

export const PREVIEW_SUMMARY: Summary = { stage: pending ? "CONFIRM_ID" : "CONFIRM_SLOT", trackingId: "BD418207", idConfirmed: !pending, bookings: 0, responseMs: 1100 };

export const PREVIEW_INTERIM = "yes, book that one";

export const PREVIEW_TIMELINE: TimelineItem[] = [
  { id: 1, seconds: 0, kind: "agent", text: "Hi, I can reschedule your delivery. What is your tracking ID?" },
  { id: 2, seconds: 6, kind: "user", text: "B as in Bravo, D as in Delta, four one eight two zero seven" },
  { id: 3, seconds: 6, kind: "info", text: "Understood so far: B D 4 1 8 2 0 7" },
  { id: 4, seconds: 7, kind: "agent", text: "Let me read that back. B as in Bravo, D as in Delta, 4 1 8 2 0 7. Is that correct?" },
  { id: 5, seconds: 12, kind: "good", text: "Caller confirmed tracking ID BD418207" },
  { id: 6, seconds: 14, kind: "agent", text: "Saturday 1 PM to 3 PM. Shall I book that?" },
  { id: 7, seconds: 19, kind: "info", text: "Booking request (attempt 1 of 2)" },
  { id: 10, seconds: 19, kind: "good", text: "Booked Saturday 1 PM to 3 PM, reference CR-7001" },
  { id: 11, seconds: 25, kind: "info", text: "Looking up delivery slots (attempt 1 of 2)", technical: true },
];
