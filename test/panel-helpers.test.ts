import { describe, expect, it } from "vitest";
import { describeChange, toNumbers } from "../src/bridge/controller.js";

describe("panel wording", () => {
  it("describes what a run changed", () => {
    const a = toNumbers({ gfa_m2: 4315, far: 1.21, coverage: "47%" });
    const b = toNumbers({ gfa_m2: 5515.4, far: 1.55, coverage: "49%" });
    expect(describeChange(a, b)).toEqual(["Floor area +1,200 m²", "FAR 1.21 → 1.55", "Coverage 47% → 49%"]);
    expect(describeChange(a, a)).toEqual([]);
  });
});
