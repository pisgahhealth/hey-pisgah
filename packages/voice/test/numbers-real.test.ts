import { describe, expect, it } from "vitest";
import { cleanTranscript, spokenDigits } from "../src/index.js";

// The four phrasings the normaliser lost on the owner's real recordings (R1.b), where the ear had heard every word right.
describe("spoken numbers from real recordings", () => {
  it("reads one thirty, one sixty over hundred, one fifty and hundred and twelve as the values said", () => {
    expect(spokenDigits("Record the blood pressure, one thirty over eighty five.")).toBe("Record the blood pressure, 130 over 85.");
    expect(spokenDigits("record her blood pressure as one sixty over hundred")).toBe("record her blood pressure as 160 over 100");
    expect(spokenDigits("Chart the blood pressure as one fifty over ninety five.")).toBe("Chart the blood pressure as 150 over 95.");
    expect(spokenDigits("Doctor, her pulse is now hundred and twelve.")).toBe("Doctor, her pulse is now 112.");
  });

  it("keeps counting, single words and decimals as they were", () => {
    expect(spokenDigits("Number one, two, three, four, five")).toBe("Number one, two, three, four, five");
    expect(spokenDigits("one two three")).toBe("one two three");
    expect(spokenDigits("give one gram of paracetamol")).toBe("give one gram of paracetamol");
    expect(spokenDigits("one hundred and four, not ninety six")).toBe("104, not 96");
    expect(cleanTranscript("Temperature thirty seven point nine.")).toBe("Temperature 37.9.");
    expect(spokenDigits("a hundred milligrams")).toBe("100 milligrams");
  });
});
