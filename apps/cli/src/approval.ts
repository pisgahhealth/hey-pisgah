type Row = Record<string, unknown>;
export type VersionRecord = { record_type: string; wall_at?: string; payload: unknown };
// A lane that plays a person's role names itself so in the approver it records; that record is not a person's own approval.
const playedByLane = (a: Row): boolean => /synthetic|build lane/i.test(`${String(a["display_name"] ?? "")} ${String(a["staff_id"] ?? "")}`);
// Who adopted, read from the approver on the adoption record: the ward manager role, and a person's own adoption only when no lane played that role.
export function adoptedByPerson(a: Row): { adopted_by_person: boolean; adopted_by_person_role: boolean } {
  const role = a["kind"] === "person" && a["role"] === "ward_manager";
  return { adopted_by_person: role && !playedByLane(a), adopted_by_person_role: role };
}
// Whether a person, not a lane playing one, approved the version now standing: read from its adoption record (approver id, kind person, time) and any later suspension or revert.
export function adoptionApproval(records: readonly VersionRecord[], version: number): Row {
  const adoption = records.find((r) => r.record_type === "version.adopted" && Number((r.payload as Row)["version"]) === version)?.payload as Row | undefined;
  const after = records.filter((r) => (r.record_type === "version.suspended" || r.record_type === "version.reverted") && Number((r.payload as Row)["version"]) === version).at(-1);
  const a = (adoption?.["approver"] ?? {}) as Row;
  const at = ((adoption?.["at"] ?? {}) as Row)["wall_at"] ?? null;
  const played = playedByLane(a);
  const human = !!adoption && a["kind"] === "person" && typeof a["staff_id"] === "string" && !!a["staff_id"] && typeof at === "string" && !played && !after;
  const why = !adoption ? "no adoption record for this version" : after ? `${after.record_type === "version.suspended" ? "suspended" : "reverted"} by ${String(((after.payload as Row)["by"] as Row | undefined)?.["staff_id"] ?? "a person")} after its adoption`
    : played ? "adopted by a person's role played by a build lane, disclosed in the record" : a["kind"] !== "person" ? "the approver is not a person" : !at ? "the adoption record has no time" : "adopted by a person";
  return { human_approval: human, approval: { approver_id: a["staff_id"] ?? null, kind: a["kind"] ?? null, at, display_name: a["display_name"] ?? null, played_by_lane: played, suspended_or_reverted: !!after, why } };
}

