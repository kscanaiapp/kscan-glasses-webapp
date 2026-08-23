import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findExistingWearableSave } from "./savedScanIdempotency.ts";

function fakeAdmin(rows: Array<Array<{ id: string }>>) {
  const filters: Array<Array<[string, string]>> = [];
  let query = 0;
  return {
    filters,
    from: () => ({
      select: () => ({
        eq(field: string, value: string) {
          const applied: Array<[string, string]> = [[field, value]];
          return {
            eq(nextField: string, nextValue: string) {
              applied.push([nextField, nextValue]);
              return {
                limit: () => {
                  filters.push(applied);
                  return Promise.resolve({ data: rows[query++] ?? [] });
                },
              };
            },
          };
        },
      }),
    }),
  };
}

Deno.test("shared Save idempotency recognizes the wearable-save local_id row", async () => {
  const admin = fakeAdmin([[{ id: "current" }]]);
  assertEquals(await findExistingWearableSave(admin, "user-1", "result-1"), { id: "current" });
  assertEquals(admin.filters, [[['user_id', 'user-1'], ['local_id', 'result-1']]]);
});

Deno.test("shared Save idempotency retains legacy wearable-bridge metadata rows", async () => {
  const admin = fakeAdmin([[], [{ id: "legacy" }]]);
  assertEquals(await findExistingWearableSave(admin, "user-1", "result-1"), { id: "legacy" });
  assertEquals(admin.filters, [
    [['user_id', 'user-1'], ['local_id', 'result-1']],
    [['user_id', 'user-1'], ['metadata->>wearableResultId', 'result-1']],
  ]);
});
