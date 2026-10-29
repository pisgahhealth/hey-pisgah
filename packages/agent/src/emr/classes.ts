const PRIMARY = ["instruction", "correction", "unclear", "finding", "patient_reported", "question_to_staff", "conditional", "option", "aside"];
// The one label the strip shows for a line: the class that matters most for what the agent did.
export const primaryClass = (classes: readonly string[]): string | null => PRIMARY.find((c) => classes.includes(c)) ?? classes[0] ?? null;
