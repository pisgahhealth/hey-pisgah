import { describe, expect, it } from "vitest";
import { buildKeywords } from "@hey-pisgah/voice";
import { staffHintsOf } from "../src/profile.js";

const owner = (label: string) => ({ label });

describe("the staff names the serve sends as hints", () => {
  it("are the owners' labels and each label without its title, when the profile lists none", () => {
    expect(staffHintsOf({ owners: [owner("Dr Edikan"), owner("Nurse Ada"), owner("Accounts")] })).toEqual(["Dr Edikan", "Edikan", "Nurse Ada", "Ada", "Accounts"]);
  });

  it("are the profile's own list when it has one, even an empty one", () => {
    expect(staffHintsOf({ owners: [owner("Dr Edikan")], staff_hints: ["Emeka", "Bisi"] })).toEqual(["Emeka", "Bisi"]);
    expect(staffHintsOf({ owners: [owner("Dr Edikan")], staff_hints: [] })).toEqual([]);
  });

  it("drop a label over the 30 characters both endpoints accept, and come after the vitals words in the hints", () => {
    expect(staffHintsOf({ owners: [owner("Consultant Physician Dr Abasiama Etim")] })).toEqual([]);
    const k = buildKeywords({ vitals: ["pulse"], wards: [], documents: ["Mrs Okon"], staff: staffHintsOf({ owners: [owner("Dr Edikan")] }), beds: [] });
    expect(k).toEqual(["pulse", "Mrs Okon", "Dr Edikan", "Edikan"]);
  });
});
