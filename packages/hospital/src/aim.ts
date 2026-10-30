// The most extra rework, in minutes, a workflow change may add on any one case; the approver accepts this figure when adopting.
export const REWORK_BUDGET_MIN_PER_CASE = 10;

export type HospitalAim = { rework_budget_min_per_case: number };

// The hospital's aim as configuration: leave sooner, break no ward requirement, and keep extra rework within the per-case budget.
export const hospitalAim = (): HospitalAim => ({ rework_budget_min_per_case: REWORK_BUDGET_MIN_PER_CASE });
