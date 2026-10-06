import test from "node:test";
import assert from "node:assert/strict";
import { parseCalendar, parseCalendarTime } from "../src/attachments/calendar.ts";

const INVITE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Pacific/Auckland",
  "BEGIN:STANDARD",
  "DTSTART:19700405T030000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "SUMMARY:Dentist\\, check-up",
  "DTSTART;TZID=Pacific/Auckland:20261014T093000",
  "DTEND;TZID=Pacific/Auckland:20261014T100000",
  "LOCATION:12 Queen St\\, Auckland",
  "DESCRIPTION:Bring your\\nreferral",
  'ORGANIZER;CN="Smile Dental: Bookings":mailto:bookings@smile.example',
  "ATTENDEE;CN=Galen;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:me@proton.me",
  "ATTENDEE:mailto:other@example.org",
  " ",
  "RRULE:FREQ=YEARLY",
  "STATUS:CONFIRMED",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

test("parseCalendar reads an invitation", () => {
  const calendar = parseCalendar(INVITE);
  assert.ok(calendar);
  assert.equal(calendar.method, "REQUEST");
  assert.equal(calendar.events.length, 1);
  const [event] = calendar.events;
  assert.deepEqual(event, {
    summary: "Dentist, check-up",
    start: { value: "2026-10-14T09:30:00", timezone: "Pacific/Auckland", allDay: false },
    end: { value: "2026-10-14T10:00:00", timezone: "Pacific/Auckland", allDay: false },
    duration: null,
    location: "12 Queen St, Auckland",
    description: "Bring your\nreferral",
    organizer: "Smile Dental: Bookings <bookings@smile.example>",
    attendees: [
      { person: "Galen <me@proton.me>", response: "ACCEPTED", role: "REQ-PARTICIPANT" },
      { person: "other@example.org", response: null, role: null }
    ],
    status: "CONFIRMED",
    recurrence: "FREQ=YEARLY",
    uid: "abc-123"
  });
});

test("folded lines are joined", () => {
  const text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:A very long\r\n  title\r\nEND:VEVENT\r\nEND:VCALENDAR";
  assert.equal(parseCalendar(text)?.events[0]?.summary, "A very long title");
});

test("parseCalendarTime handles all-day, UTC and floating times", () => {
  assert.deepEqual(parseCalendarTime("20261225", { VALUE: "DATE" }), { value: "2026-12-25", timezone: null, allDay: true });
  assert.deepEqual(parseCalendarTime("20261014T203000Z"), { value: "2026-10-14T20:30:00Z", timezone: "UTC", allDay: false });
  assert.deepEqual(parseCalendarTime("20261014T093000"), { value: "2026-10-14T09:30:00", timezone: null, allDay: false });
});

test("parseCalendar returns null for something that is not a calendar", () => {
  assert.equal(parseCalendar("Just some text"), null);
});
