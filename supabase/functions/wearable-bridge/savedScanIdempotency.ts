/**
 * The two wearable Save entry points must resolve the same persisted scan.
 * `local_id` is the current canonical key; the metadata lookup keeps rows
 * written by earlier wearable-bridge versions idempotent during migration.
 */
export async function findExistingWearableSave(
  admin: any,
  userId: string,
  resultId: string,
): Promise<{ id: string } | null> {
  const { data: current } = await admin
    .from("saved_scans")
    .select("id")
    .eq("user_id", userId)
    .eq("local_id", resultId)
    .limit(1);
  if (current && current.length > 0) return current[0];

  const { data: legacy } = await admin
    .from("saved_scans")
    .select("id")
    .eq("user_id", userId)
    .eq("metadata->>wearableResultId", resultId)
    .limit(1);
  return legacy && legacy.length > 0 ? legacy[0] : null;
}
