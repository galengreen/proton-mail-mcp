// A small reader for iCalendar (RFC 5545) invites: enough to say what an
// event is, when and where it happens, and who is invited. Times are kept as
// written, with their time zone, rather than converted.

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Component {
  type: string;
  properties: Property[];
  children: Component[];
}

export interface CalendarTime {
  /** "2026-10-06" for an all-day date, "2026-10-06T14:30:00" otherwise, with "Z" for UTC. */
  value: string;
  /** The TZID of a local time, "UTC" for a UTC time, null for floating or all-day times. */
  timezone: string | null;
  allDay: boolean;
}

export interface Attendee {
  /** "Name <address>", or the address alone. */
  person: string;
  /** PARTSTAT: NEEDS-ACTION, ACCEPTED, DECLINED or TENTATIVE; null when not given. */
  response: string | null;
  /** ROLE: REQ-PARTICIPANT, OPT-PARTICIPANT, CHAIR; null when not given. */
  role: string | null;
}

export interface CalendarEvent {
  summary: string | null;
  start: CalendarTime | null;
  end: CalendarTime | null;
  duration: string | null;
  location: string | null;
  description: string | null;
  organizer: string | null;
  attendees: Attendee[];
  status: string | null;
  recurrence: string | null;
  uid: string | null;
}

export interface Calendar {
  /** REQUEST for an invitation, CANCEL for a cancellation, REPLY for a response. */
  method: string | null;
  events: CalendarEvent[];
}

/** Undo line folding: a line break followed by a space or tab continues the line. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((line) => line !== "");
}

/** Split a content line at separators that are not inside double quotes. */
function splitOutsideQuotes(text: string, separator: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted && parts.length < limit - 1) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseProperty(line: string): Property | null {
  const [head, value] = splitOutsideQuotes(line, ":", 2);
  if (head === undefined || value === undefined) return null;
  const [name = "", ...rawParams] = splitOutsideQuotes(head, ";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf("=");
    if (eq > 0) params[raw.slice(0, eq).toUpperCase()] = raw.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: name.toUpperCase(), params, value };
}

function parseComponents(lines: string[]): Component[] {
  const root: Component = { type: "ROOT", properties: [], children: [] };
  const stack: Component[] = [root];
  for (const line of lines) {
    const property = parseProperty(line);
    if (!property) continue;
    const top = stack[stack.length - 1] ?? root;
    if (property.name === "BEGIN") {
      const child: Component = { type: property.value.toUpperCase(), properties: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (property.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      top.properties.push(property);
    }
  }
  return root.children;
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

export function parseCalendarTime(value: string, params: Record<string, string> = {}): CalendarTime {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || params.VALUE === "DATE") {
    return { value: date ? `${date[1]}-${date[2]}-${date[3]}` : value, timezone: null, allDay: true };
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time) return { value, timezone: params.TZID ?? null, allDay: false };
  const utc = time[7] === "Z";
  return {
    value: `${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}${utc ? "Z" : ""}`,
    timezone: utc ? "UTC" : (params.TZID ?? null),
    allDay: false
  };
}

function person(property: Property): string {
  const address = property.value.replace(/^mailto:/i, "");
  return property.params.CN ? `${property.params.CN} <${address}>` : address;
}

function attendee(property: Property): Attendee {
  return {
    person: person(property),
    response: property.params.PARTSTAT?.toUpperCase() ?? null,
    role: property.params.ROLE?.toUpperCase() ?? null
  };
}

function toEvent(component: Component): CalendarEvent {
  const first = (name: string) => component.properties.find((p) => p.name === name);
  const text = (name: string) => {
    const p = first(name);
    return p ? unescapeText(p.value) : null;
  };
  const time = (name: string) => {
    const p = first(name);
    return p ? parseCalendarTime(p.value, p.params) : null;
  };
  const organizer = first("ORGANIZER");
  return {
    summary: text("SUMMARY"),
    start: time("DTSTART"),
    end: time("DTEND"),
    duration: first("DURATION")?.value ?? null,
    location: text("LOCATION"),
    description: text("DESCRIPTION"),
    organizer: organizer ? person(organizer) : null,
    attendees: component.properties.filter((p) => p.name === "ATTENDEE").map(attendee),
    status: first("STATUS")?.value ?? null,
    recurrence: first("RRULE")?.value ?? null,
    uid: first("UID")?.value ?? null
  };
}

/** Parse an iCalendar document, or return null when `text` is not one. */
export function parseCalendar(text: string): Calendar | null {
  const calendar = parseComponents(unfold(text)).find((c) => c.type === "VCALENDAR");
  if (!calendar) return null;
  const method = calendar.properties.find((p) => p.name === "METHOD")?.value.toUpperCase() ?? null;
  const events = calendar.children.filter((c) => c.type === "VEVENT").map(toEvent);
  return { method, events };
}
