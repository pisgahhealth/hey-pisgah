export type DemoStep = { n: number; title: string; short: string; lede: string; ready: boolean };

// The six-step story; steps 2 to 4 and 6 are shells until lane L2.4 fills them.
export const STEPS: readonly DemoStep[] = [
  { n: 1, title: "Ambiguous journeys", short: "Journeys", lede: "Twelve discharges from the simulated ward, as the record shows them. Each line has two clocks: when the work happened and when it was recorded.", ready: true },
  { n: 2, title: "Investigation", short: "Investigate", lede: "Explanations the agent formed, the events each one cites, and the explanations competing with it.", ready: false },
  { n: 3, title: "Experiments", short: "Experiments", lede: "Matched experiments: control and intervention on the same seed, with the prediction and how it landed.", ready: false },
  { n: 4, title: "Change", short: "Change", lede: "The proposed change to the ward's process, shown as a diff, with where it applies and the dev gate result.", ready: false },
  { n: 5, title: "Adopt and execute", short: "Execute", lede: "The agent working one discharge: what it prepared, the proof for each item, and the waits in between.", ready: true },
  { n: 6, title: "Changed requirement", short: "New rule", lede: "Ward B's requirement changes. The agent's path, the conflict it raised and the person's decision.", ready: false }
];

export function stepOf(n: number): DemoStep | null {
  return STEPS.find((s) => s.n === n) ?? null;
}
