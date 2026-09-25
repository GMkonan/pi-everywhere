import assert from "node:assert/strict";
import { test } from "node:test";
import { claimProcessRuntime, getProcessInstanceId } from "../src/extension/process-identity.js";

test("process identity remains stable for repeated callers", () => {
  const first = getProcessInstanceId();
  const second = getProcessInstanceId();

  assert.equal(second, first);
  assert.match(first, new RegExp(`^${process.pid}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i"));
});

test("claimProcessRuntime stops an older extension copy without releasing the replacement", () => {
  let firstStops = 0;
  let secondStops = 0;
  const releaseFirst = claimProcessRuntime(() => { firstStops += 1; });
  const releaseSecond = claimProcessRuntime(() => { secondStops += 1; });

  assert.equal(firstStops, 1);
  releaseFirst();

  const releaseThird = claimProcessRuntime(() => {});
  assert.equal(secondStops, 1);

  releaseSecond();
  releaseThird();
});
