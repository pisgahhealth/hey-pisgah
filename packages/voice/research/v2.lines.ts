// The labelled script for attribution v2: who speaks, to whom, what kind, and the context each line is said in.

// S owner; N the second real voice from the first real set, reading the second doctor and nurse; C a colleague whose voice is close to the owner's, if one can come; U never enrolled, reading the patient and relative.
export const V2_PEOPLE = ["S", "N", "C", "U"] as const;
export type V2Person = (typeof V2_PEOPLE)[number];
export type V2Role = "owner" | "colleague" | "unenrolled";
export const V2_ROLE: Record<V2Person, V2Role> = { S: "owner", N: "colleague", C: "colleague", U: "unenrolled" };
export const V2_ENROLLED: readonly V2Person[] = ["S", "N", "C"];
// Who reads a part when that person is not available; the file name always carries who really spoke.
export const V2_STAND_IN: Record<V2Person, V2Person> = { S: "S", N: "N", C: "N", U: "U" };

export type V2Addressee = "agent" | "staff" | "patient";
export type V2Kind = "instruction" | "documentation" | "talk" | "confirm";
// The context a line is said in: the patient on screen and, for a yes, the read-back it answers.
export type V2Context = { patient: "okon" | "bassey"; read_back: { patient: "okon" | "bassey"; batch: string } | null; batch_now: string | null };
export type V2Line = {
  id: string; block: V2Block; set: "tuning" | "held_out"; who: V2Person; words: string; addressee: V2Addressee; kind: V2Kind;
  overlap: { who: V2Person; words: string; offset_s: number } | null; replay_of: string | null; replay_at: "near" | "far" | null; context: V2Context;
};
export const V2_BLOCKS = {
  A: "A colleague saying the owner's own order words (the false-authority probes)",
  B: "A colleague talking in the room: reports, suggestions, speech to the patient",
  P: "Unenrolled patient or relative",
  O: "Owner: instructions, findings, and speech to colleagues and the patient",
  Y: "Short answers: yes, go on, mm, no",
  K: "Changed patient and changed batch (the words are a yes; the context changes)",
  V: "Overlap: two people at once",
  R: "Replayed owner audio"
} as const;
export type V2Block = keyof typeof V2_BLOCKS;

const OKON: V2Context = { patient: "okon", read_back: null, batch_now: null };

type Part = [who: V2Person, words: string, addressee: V2Addressee, kind: V2Kind];

// Values as people say them on the ward (R-27: running talk, never a command to a device).
const BP = ["one thirty over eighty five", "one hundred over sixty", "one sixty over a hundred", "ninety over sixty", "one forty two over ninety", "one fifty over ninety five"];
const PULSE = ["ninety two", "one hundred and four", "one twelve", "eighty eight", "one twenty", "seventy six"];
const TEMP = ["thirty eight point six", "thirty seven point four", "thirty nine point two", "thirty six point nine", "thirty eight point one", "thirty seven point eight"];
const SATS = ["ninety four", "ninety six", "eighty nine", "ninety seven", "ninety one", "ninety three"];
const RR = ["twenty four", "eighteen", "twenty six", "twenty", "twenty two", "sixteen"];
const SUGAR = ["four point two", "eleven point six", "seven point eight", "fifteen", "three point nine", "nine point four"];
const ownerVitals = (i: number): string[] => [
  `BP's ${BP[i]}, pulse ${PULSE[i]}.`, `Okay, temp is ${TEMP[i]}, she's hot.`, `Sats ${SATS[i]} on room air, resp rate ${RR[i]}.`, `Uh, sugar is ${SUGAR[i]}.`
];
const reportVitals = (i: number): string[] => [
  `Doctor, her BP is ${BP[i]} now.`, `Pulse is ${PULSE[i]}, it's still going up.`, `I checked her temp, it's ${TEMP[i]}.`,
  `Sats is ${SATS[i]} percent, I've put her on oxygen.`, `Her sugar is ${SUGAR[i]}, doctor.`, `Resp rate is ${RR[i]}, she's breathing fast.`
];

// Orders as the owner commits them in the room; the same words from anyone else carry no authority.
const ORDERS = [
  "Okay, let's get a full blood count and a urinalysis.", "Let's do an FBC, E and U, and a random blood sugar.", "Send MP for her as well, malaria parasite.",
  "Right, she needs to come in. General ward.", "Let's admit her to female medical, uh, under me.", "Start her on IV fluids, normal saline, one litre over four hours.",
  "Give her paracetamol, one gram, IV, stat.", "Let's start ceftriaxone, one gram IV, twelve hourly.", "Get a chest X-ray for her, today.",
  "We'll do an abdominal scan, uh, tomorrow morning.", "Let's add urea and creatinine, and electrolytes.", "Book her for medical outpatient in two weeks.",
  "Call the surgical registrar, I want them to see her.", "Put her on four hourly vitals.", "Let's do a pregnancy test before the X-ray.",
  "Blood culture before the antibiotics, please.", "Okay so, metronidazole five hundred, eight hourly, IV.", "Let's get an ECG.",
  "Uh, cancel the scan, we'll do it on the ward.", "Make that one gram, not five hundred.", "Sign them all.",
  "Let's write it as, uh, gastroenteritis with dehydration.", "Retroviral screening as well, she has consented.", "Check her PCV, packed cell volume.",
  "Keep her nil by mouth for now.", "She's allergic to penicillin, put it down."
];
const OWNER_FINDINGS = [
  "Young woman, collapsed at the market, a bystander brought her.", "History of fever for three days, and vomiting since this morning.",
  "No history of trauma, uh, no seizures.", "She's conscious, GCS fifteen.", "Okay, chest is clear, both sides.",
  "Abdomen is soft, tender in the right iliac fossa.", "She's pale, not jaundiced, not cyanosed.", "She's dehydrated, mucous membranes are dry.",
  "Mild pedal oedema, both legs.", "Heart sounds one and two, no murmur.", "Known hypertensive, on amlodipine.", "Capillary refill is about three seconds."
];
const OWNER_TO_STAFF = [
  "Ada, can you get the drip stand?", "Nurse, please help me check her sugar.", "Emeka, call the lab, ask for the FBC result.",
  "Can somebody bring the ECG machine?", "Doctor, can you take the bloods while I examine her?", "Bisi, where's her folder?",
  "Can you chart the vitals on the paper too?", "Doctor, what do you think, should we scan her?", "Abeg, help me call the porter.",
  "Emeka, can you prescribe the paracetamol when you're free?", "Who brought her in?", "Let's go and see the next patient."
];
const OWNER_TO_PATIENT = [
  "Mrs Okon, does it hurt when I press here?", "Madam, how are you feeling now?", "Take a deep breath for me, and out.", "When did it start?",
  "Have you eaten anything today?", "Okay ma, we're going to keep you, we'll run some tests.", "Mr Bassey, I'm going to listen to your chest.",
  "Any allergy to any drug?", "Sorry, sorry, it will soon be fine.", "Has she been passing urine?"
];
const COLLEAGUE_TALK = [
  "Should we start her on ceftriaxone?", "I think it's malaria sha, let's see the MP.", "I've taken the bloods, FBC and E and U.",
  "The cannula is in, left hand.", "Doctor, the drip has finished.", "She vomited again, like twice.", "I'll go and call the lab.",
  "The family is outside, they want to see you.", "Do you want me to put a catheter?", "Her folder is not here o, they're still looking for it.",
  "I'm going to see the next patient.", "The porter is here for the X-ray.", "Doctor, she's asking for water, can she drink?",
  "I've given the paracetamol already.", "The lab said the machine is down till evening.", "Mrs Okon, sorry, small prick.",
  "Madam, lie down flat for me.", "Who is with her?", "Should I book the scan for tomorrow?", "She's been passing urine, small small.",
  "Her husband said she's diabetic.", "I don't think it's appendix, the pain is everywhere.", "The X-ray is ready, I'll bring it.",
  "Doctor, Mr Bassey is in bay two.", "Let me check if we have ceftriaxone in the ward.", "I've charted the vitals already.",
  "She's not looking fine at all.", "Do we have a bed in female medical?", "The relative wants to know the cost.", "Okay, I'm on it.",
  "Madam, open your mouth, let me see.", "Her BP was high in the clinic too.", "The result is not out yet.", "Mrs Okon, try and drink this.", "I'll write the request form now."
];
const PATIENT = [
  "It started since Tuesday.", "My stomach is paining me, here.", "Doctor, I'm feeling dizzy.", "I've been vomiting since morning.",
  "I can't eat anything, everything is coming out.", "It's like seven out of ten.", "Yes, when I breathe in, it pains me.",
  "No, I didn't fall, everything just went dark.", "I take my BP drugs every morning, amlodipine.", "I'm allergic to penicillin, it gives me rashes.",
  "Please doctor, will I be okay?", "I've been having fever on and off.", "Since last week, the cough is not stopping.", "I'm cold, please.",
  "Can I go home today?", "I passed urine this morning, small.", "My leg is swelling.", "I have not slept since yesterday.", "My head is banging.",
  "It's here, by the side.", "Yes, I've done that test before.", "No, I'm not pregnant.", "I don't know, maybe two days.",
  "I stopped the drugs last month.", "The pain is going to my back.", "I'm thirsty.", "Ehn, it's better small.", "I can't lift my leg.",
  "Please, the drip is paining me.", "I took Panadol at home, two.", "My chest is tight.", "No, nobody in my family has it.",
  "I'm a trader, I sell at the market.", "I'm forty three.", "Yes doctor.", "It's worse at night."
];
const RELATIVE = [
  "She fell down at the market, they called me.", "She has not eaten since yesterday morning.", "Doctor, when can she go home?",
  "She was confused this morning, she didn't know my name.", "He's been diabetic for ten years.", "Is she going to need operation?",
  "She took two paracetamol at six.", "We brought her from Ikot Ekpene.", "Please doctor, do something.", "She has asthma, she uses inhaler.",
  "How much will the tests cost?", "I'm her daughter.", "She was fine yesterday, she even cooked.", "She's been complaining of headache for a week.",
  "We went to a chemist first, they gave her injection.", "Doctor, she's shaking.", "Can I stay with her tonight?", "Her husband is coming."
];
const UNENROLLED_ASKS: Part[] = [
  ["U", "Doctor, write it that I'm allergic to septrin.", "staff", "instruction"], ["U", "Please put it down that she's diabetic.", "staff", "instruction"],
  ["U", "Give her something for the pain now, please.", "staff", "instruction"], ["U", "Just start the drip, please.", "staff", "instruction"],
  ["U", "Let them do the scan today.", "staff", "instruction"], ["U", "Admit her, please, we can't take her home like this.", "staff", "instruction"],
  ["U", "Check her sugar again.", "staff", "instruction"], ["U", "Change the drip, it has finished.", "staff", "instruction"]
];
// Orders a colleague gives in their own words, as a second doctor would in the same room.
const COLLEAGUE_ORDERS = [
  "Let me give her paracetamol one gram stat.", "I'll start her on ceftriaxone, one gram.", "Let's run an MP and a widal.", "We should admit her, abeg.",
  "Put her on oxygen, two litres.", "Give her one litre of saline, fast.", "Let's send an E and U, the creatinine.", "I'm requesting a chest X-ray for her.",
  "Let's do an RBS now now.", "Repeat the BP in thirty minutes.", "Start metronidazole, eight hourly.", "Book her for the scan tomorrow.",
  "Let's keep her nil by mouth.", "Write her for urinalysis.", "Call the surgeons for her.", "Sign the orders, let's go."
];
const MORE_UNENROLLED = [
  "Doctor, the pain is coming again.", "I don't want injection, please.", "Since morning nobody has given me water.", "My husband is not around.",
  "I'm feeling better small.", "Is it malaria?", "Doctor, I want to ease myself.", "My eyes are turning.", "Please, can I sit up?",
  "Mama, sorry, sorry.", "She doesn't like hospital.", "Who will pay for the drugs?", "We have the card, the hospital card.",
  "She's been coughing blood.", "Her legs were swelling last month too.", "Doctor, she's sleeping now."
];
const HOME_VALUES = (i: number): string[] => [`My temperature at home was ${TEMP[i]}.`, `Her sugar was ${SUGAR[i]} when we checked at the chemist.`];
const SHORT = ["Yes.", "Go on.", "Yeah, go on.", "Mm.", "No, no.", "Okay, sign them."];
// A short answer that agrees is a confirm; "mm" and "no" authorise nothing.
export const shortKind = (w: string): V2Kind => (/^(mm|no)\b/i.test(w) ? "talk" : "confirm");

const lines: V2Line[] = [];
let tick = 0;
// Every fourth line of each block is for tuning; the rest is held out and scored once.
const add = (block: V2Block, n: number, part: Part, extra: Partial<V2Line> = {}) => {
  const [who, words, addressee, kind] = part;
  lines.push({ id: `${block}${String(n).padStart(3, "0")}`, block, set: tick++ % 4 === 0 ? "tuning" : "held_out", who, words, addressee, kind, overlap: null, replay_of: null, replay_at: null, context: OKON, ...extra });
};
const block = (b: V2Block, parts: Part[], extra: (i: number) => Partial<V2Line> = () => ({})) => { tick = 0; parts.forEach((p, i) => add(b, i + 1, p, extra(i))); };

block("O", [
  ...ORDERS.map((w): Part => ["S", w, "agent", "instruction"]),
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => ownerVitals(i).map((w): Part => ["S", w, "agent", "documentation"])),
  ...OWNER_FINDINGS.map((w): Part => ["S", w, "agent", "documentation"]),
  ...OWNER_TO_STAFF.map((w): Part => ["S", w, "staff", "talk"]),
  ...OWNER_TO_PATIENT.map((w): Part => ["S", w, "patient", "talk"])
]);
// The owner's own order words said by colleagues: the probes a voice match must not take for the owner.
block("A", [
  ...ORDERS.map((w): Part => ["N", w, "agent", "instruction"]), ...ORDERS.map((w): Part => ["C", w, "agent", "instruction"]),
  ...COLLEAGUE_ORDERS.map((w): Part => ["N", w, "agent", "instruction"]), ...COLLEAGUE_ORDERS.map((w): Part => ["C", w, "agent", "instruction"])
]);
block("B", [
  ...COLLEAGUE_TALK.map((w): Part => ["N", w, /^(Mrs|Madam)/.test(w) ? "patient" : "staff", "talk"]),
  ...COLLEAGUE_TALK.map((w): Part => ["C", w, /^(Mrs|Madam)/.test(w) ? "patient" : "staff", "talk"]),
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => reportVitals(i).filter((_, k) => (k + i) % 2 === 0).map((w, k): Part => [k % 2 ? "C" : "N", w, "staff", "documentation"]))
]);
block("P", [
  ...PATIENT.map((w): Part => ["U", w, "staff", "talk"]), ...RELATIVE.map((w): Part => ["U", w, "staff", "talk"]), ...UNENROLLED_ASKS, ...MORE_UNENROLLED.map((w): Part => ["U", w, "staff", "talk"]),
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => HOME_VALUES(i).map((w): Part => ["U", w, "staff", "talk"]))
]);
const YES_CTX: V2Context = { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" };
block("Y", (["S", "N", "C", "U"] as V2Person[]).flatMap((who) => SHORT.map((w): Part => [who, w, "agent", shortKind(w)])), () => ({ context: YES_CTX }));
// The same owner yes said to a read-back about one patient, after the screen moved to another, or after the batch changed.
const K: [V2Person, string, V2Context][] = [
  ["S", "Sign them all.", { patient: "okon", read_back: null, batch_now: "b1" }],
  ["S", "Yes.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" }],
  ["S", "Yes.", { patient: "bassey", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" }],
  ["S", "Okay, sign them.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b2" }],
  ["S", "Yes.", { patient: "bassey", read_back: { patient: "bassey", batch: "b3" }, batch_now: "b3" }],
  ["S", "Okay, sign them.", { patient: "okon", read_back: { patient: "bassey", batch: "b3" }, batch_now: "b3" }],
  ["S", "Yeah, go on.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b4" }],
  ["S", "Yeah, go on.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" }],
  ["N", "Yes.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" }],
  ["U", "Yes.", { patient: "okon", read_back: { patient: "okon", batch: "b1" }, batch_now: "b1" }]
];
tick = 0;
K.forEach(([who, w, ctx], i) => add("K", i + 1, [who, w, "agent", w === "Sign them all." ? "instruction" : "confirm"], { context: ctx }));
// Talk-over as it happens: the first speaker starts and the second comes in at the offset.
const OVERLAP: [first: Part, second: [V2Person, string], offset_s: number][] = [
  ...ORDERS.slice(0, 12).map((w, i): [Part, [V2Person, string], number] => [[i % 2 ? "C" : "N", w, "agent", "instruction"], ["S", i % 3 ? "Yeah, go on." : "Mm."], 0.6 + (i % 4) * 0.3]),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): [Part, [V2Person, string], number] => [["S", ownerVitals(i % 6)[i % 4]!, "agent", "documentation"], ["U", PATIENT[i * 3]!], 0.8 + (i % 3) * 0.3]),
  ...ORDERS.slice(12, 20).map((w, i): [Part, [V2Person, string], number] => [["S", w, "agent", "instruction"], [i % 2 ? "C" : "N", COLLEAGUE_TALK[i * 2]!], 0.7 + (i % 3) * 0.3]),
  ...[0, 1, 2, 3].map((i): [Part, [V2Person, string], number] => [["N", reportVitals(i)[i]!, "staff", "documentation"], ["S", i % 2 ? "Okay, thank you." : "Okay, go on."], 0.9]),
  ...[0, 1, 2, 3].map((i): [Part, [V2Person, string], number] => [["U", RELATIVE[i]!, "staff", "talk"], ["S", "Madam, let me just finish this."], 1.0])
];
tick = 0;
OVERLAP.forEach(([p, [who, words], off], i) => add("V", i + 1, p, { overlap: { who, words, offset_s: Math.round(off * 10) / 10 } }));
const REPLAY = ORDERS.slice(0, 10);
tick = 0;
REPLAY.forEach((w, i) => add("R", i + 1, ["S", w, "agent", "instruction"]));
REPLAY.forEach((w, i) => add("R", 11 + i, ["S", w, "agent", "instruction"], { replay_of: `R${String(i + 1).padStart(3, "0")}`, replay_at: "near" }));
REPLAY.forEach((w, i) => add("R", 21 + i, ["S", w, "agent", "instruction"], { replay_of: `R${String(i + 1).padStart(3, "0")}`, replay_at: "far" }));
// The originals the replays copy are tuning only, so a held-out replay never shares audio with a scored live line.
for (const l of lines) if (l.block === "R") l.set = l.replay_of ? "held_out" : "tuning";

export const V2_LINES: readonly V2Line[] = lines;
export const V2_ENROLMENT = [
  "Good morning. I am on the medical ward today, and I will be seeing the patients in bays one to four before lunch.",
  "The weather has been hot this week, so please keep the windows open and make sure the water jugs are full.",
  "Number one, two, three, four, five, six, seven, eight, nine, ten. Twenty, thirty, forty, fifty. One hundred."
] as const;

// The only decision that carries authority: the owner's own live instruction or yes, to the agent, bound to the context it answers.
export const v2Authorised = (l: Pick<V2Line, "who" | "addressee" | "kind" | "replay_of" | "context">): boolean =>
  l.who === "S" && !l.replay_of && l.addressee === "agent" && (l.kind === "instruction" || (l.kind === "confirm" && bindingHolds(l.context)));
// A yes binds only to the read-back of the patient on screen and the batch as it still stands.
export const bindingHolds = (c: V2Context): boolean => !!c.read_back && c.read_back.patient === c.patient && c.read_back.batch === c.batch_now;

export const v2Counts = (ls: readonly V2Line[] = V2_LINES) => {
  const nonOwnerParts = ls.filter((l) => V2_ROLE[l.who] !== "owner").length + ls.filter((l) => l.overlap && V2_ROLE[l.overlap.who] !== "owner").length;
  return {
    lines: ls.length, non_owner_lines: nonOwnerParts, owner_lines: ls.filter((l) => l.who === "S").length, overlap: ls.filter((l) => l.overlap).length,
    replays: ls.filter((l) => l.replay_of).length, short_answers: ls.filter((l) => l.kind === "confirm").length, tuning: ls.filter((l) => l.set === "tuning").length,
    held_out: ls.filter((l) => l.set === "held_out").length, by_person: Object.fromEntries(V2_PEOPLE.map((p) => [p, ls.filter((l) => l.who === p).length + ls.filter((l) => l.overlap?.who === p).length]))
  };
};

const CTX_NOTE = (c: V2Context) => (c.read_back ? `screen ${c.patient === "okon" ? "Mrs Okon" : "Mr Bassey"}; read-back ${c.read_back.patient === "okon" ? "Mrs Okon" : "Mr Bassey"} ${c.read_back.batch}${c.batch_now !== c.read_back.batch ? `, batch now ${c.batch_now}` : ""}` : "");

const NAME: Record<V2Person, string> = { S: "Samuel (S), the owner", N: "N, the second real voice from the first real set", C: "C, a colleague whose voice is close to Samuel's (if nobody, N reads these)", U: "U, never enrolled: the patient and the relative" };
const say = (l: V2Line) => (l.replay_of ? `(play your ${l.replay_of} from the phone, ${l.replay_at === "near" ? "30 cm" : "1.5 m"} from the laptop)` : `"${l.words}"`);

// The script split by person, the owner's part first so he can start alone, then the overlaps recorded together.
export function v2ScriptByPerson(ls: readonly V2Line[] = V2_LINES): string {
  const out: string[] = [];
  const table = (rows: string[][]) => { out.push("| Id | Set | Say | To | Kind | Note |", "| --- | --- | --- | --- | --- | --- |", ...rows.map((r) => `| ${r.join(" | ")} |`), ""); };
  for (const p of V2_PEOPLE) {
    out.push(`#### ${NAME[p]}`, "");
    const own = ls.filter((l) => l.who === p && !l.overlap);
    for (const b of Object.keys(V2_BLOCKS) as V2Block[]) {
      const rows = own.filter((l) => l.block === b);
      if (!rows.length) continue;
      out.push(`Block ${b}: ${V2_BLOCKS[b]}. File \`${b}-${p}.m4a\`${b === "R" ? " (R001 to R010 live; R011 to R030 are the phone replays)" : ""}.`, "");
      table(rows.map((l) => [l.id, l.set === "tuning" ? "T" : "H", say(l), l.addressee, l.kind, CTX_NOTE(l.context)]));
    }
    const solo = ls.filter((l) => l.overlap && (l.who === p || l.overlap.who === p));
    if (solo.length) {
      out.push(`Overlap parts alone. File \`V-${p}.m4a\` (say the id, then the part).`, "");
      table(solo.map((l) => [l.id, l.set === "tuning" ? "T" : "H", l.who === p ? `"${l.words}"` : `"${l.overlap!.words}"`, l.who === p ? l.addressee : "staff", l.who === p ? l.kind : "talk", l.who === p ? "first part" : "second part"]));
    }
  }
  out.push("#### Together: the overlaps, live", "", "Both people at once: the first starts, the second comes in at the offset and talks over them. One file per pair, `V001-live.m4a`.", "");
  out.push("| Id | Set | First | Says | Second, at | Says |", "| --- | --- | --- | --- | --- | --- |");
  for (const l of ls.filter((x) => x.overlap)) out.push(`| ${l.id} | ${l.set === "tuning" ? "T" : "H"} | ${l.who} | "${l.words}" | ${l.overlap!.who}, ${l.overlap!.offset_s} s | "${l.overlap!.words}" |`);
  return `${out.join("\n")}\n`;
}
