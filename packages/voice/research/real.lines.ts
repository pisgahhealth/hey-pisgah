import { LINES, type Addressee, type LineKind, type Person } from "./lines.js";

// Samuel's real recordings (29 Oct): each clip names its source file, the cut in seconds, and the kind re-derived from the words he said.
export type RealClip = {
  id: string; set: "enrolment" | "tuning" | "final" | "extra"; source: string; start_s: number | null; end_s: number | null;
  who: Person; addressee: Addressee | null; kind: LineKind | null; said: string; kind_changed: boolean; addressee_doubt: boolean; note: string | null;
};

type Row = [id: string, source: string, cut: [number, number] | null, said: string, kind: LineKind | null, note?: string];

// What was said is read from both transcribers and the script, so each row is a reconstruction, never a listened transcript.
const ROWS: Row[] = [
  ["E1", "E1", null, "Good morning. I am on the medical ward today and I will be seeing the patients, all the patients, before lunch.", null],
  ["E2", "E2", null, "The weather has been hot this week, so please keep the windows open and the water jugs full. Where is the janitor? Please keep the windows open.", null],
  ["E3", "E3", null, "Number one, two, three, four, five, six, seven, eight, nine, ten. Twenty, thirty, forty, fifty. One hundred.", null],
  ["T01", "T01", null, "Chart her pulse at ninety two.", "instruction"],
  ["T02", "T02", null, "Record her blood pressure, one thirty over eighty five.", "instruction"],
  ["T03", "T03", null, "Page the surgical registrar to review her today.", "instruction"],
  ["T04", "T04", null, "Write a progress note, abdomen soft, mild tenderness on the right.", "instruction"],
  ["T05", "T05", null, "Chest is clear on both sides. There is no added sound.", "documentation"],
  ["T06", "T06", null, "Capillary refill is under two seconds and she looks well hydrated, though.", "documentation"],
  ["T07", "T07", null, "Nurse, can you bring the drip stand over here?", "talk"],
  ["T08", "T08", null, "Emeka, please call the lab and ask about her blood counts.", "talk"],
  ["T09", "T09", null, "Mrs Okon, does it hurt when I press here? Please could you answer?", "talk"],
  ["T10", "T10", null, "Okay, would you mind, please take a deep breath in for me, and out.", "talk"],
  ["T11", "T11", null, "Chart a temperature of thirty eight point one.", "instruction"],
  ["T12", "T12", null, "Hey Pisgah, we need to admit this patient to the medical ward. We need to admit this patient right now. It is very important.", "instruction"],
  ["T13", "T13", null, "Nurse, we need to start her on IV ceftriaxone and give her one gram twice a day.", "instruction"],
  ["T14", "T14", null, "Doctor, her oxygen saturation, doctor, her oxygen saturation is ninety four percent on room air.", "documentation"],
  ["T15", "T15", null, "Record that she passed urine this morning. It is very important. The relative said she passed urine this morning.", "instruction"],
  ["T16", "T16+T17", [2.9, 9.0], "It started three days ago, doctor. The pain moves to my back.", "talk"],
  ["T17", "T16+T17", [9.4, 16.3], "My temperature at home was very high last night. I was just hot, but I do not know the number.", "talk"],
  ["T18", "T18+T19", [0.0, 5.9], "I also, I am allergic to penicillin, oh please.", "talk", "the request to write it down was dropped, so it is patient talk"],
  ["T19", "T18+T19", [6.1, 15.87], "I have not vomited. I have not vomited today.", "talk"],
  ["T20", "T20+T21", [1.6, 5.2], "Doctor, she has not eaten anything since yesterday morning, oh.", "talk"],
  ["T21", "T20+T21", [5.6, 13.23], "Please, we do not have too much money, so when can she, when can we get her well so she can go home?", "talk"],
  ["T22", "T22+T23", [0.7, 13.0], "Chart the respiratory rate, the respiratory rate at twenty. [P] I just feel so tired all the time.", "instruction", "the patient's line follows the owner's rather than overlapping it"],
  ["T23", "T22+T23", [13.5, 27.39], "Put the pulse down to one hundred and ten. [S] Please can you bring the chart? Let me look at it, because I think I do not remember what we did before.", "instruction"],
  ["T24", "T24+H43", [1.7, 8.3], "I have had this cough for two weeks. [S] Hmm, okay.", "talk"],
  ["H01", "H01", null, "Okay, chart the temperature as thirty seven point eight.", "instruction"],
  ["H02", "H02", null, "Record pulse eighty eight and respiratory rate eighteen.", "instruction"],
  ["H03", "H03", null, "Blood pressure is about one forty over ninety, please put that down.", "instruction"],
  ["H04", "H04", null, "Chart her oxygen saturation, it is about ninety six percent.", "instruction"],
  ["H05", "H05", null, "Please page the nurse in charge to come to bed four. Nurse, would you please come to bed four.", "instruction"],
  ["H06", "H06", null, "We need to admit this patient. We need the patient to be stable and then we can move them to the female medical ward. It is quite urgent, but let them be stable in the emergency ward first.", "instruction"],
  ["H07", "H07", null, "And please book a follow up in the surgical clinic in two weeks. You can also invite her to come and check her head.", "instruction"],
  ["H08", "H08", null, "For the round notes, she seems to be tolerating oral fluids, particularly the antibiotics. On examination she is quite alert and her abdomen is soft.", "documentation", "the request to write a note became the note itself"],
  ["H09", "H09", null, "On observation she is quite alert and her abdomen is quite soft.", "documentation"],
  ["H10", "H10", null, "There is mild pitting oedema in both ankles.", "documentation"],
  ["H11", "H11", null, "Checking her heart, the heart sounds one and two, no murmur.", "documentation"],
  ["H12", "H12", null, "She also looks pale, and the conjunctivae appear pale too.", "documentation"],
  ["H13", "H13", null, "Nurse Bisi, please check her blood sugar now. It is very important, so we can record that.", "talk"],
  ["H14", "H14", null, "Please can someone bring the ECG machine to bed four. Please be quick.", "talk"],
  ["H15", "H15", null, "Emeka, did the lab send the urea and electrolytes yet? Please check them, there should be a point of care machine there. Please be fast, it is very important.", "talk"],
  ["H16", "H16", null, "Let us get her a chest X-ray, it is also very important.", "talk"],
  ["H17", "H17", null, "Please, would you mind looking at me, Mrs Okon? How many times did you pass stool yesterday?", "talk"],
  ["H18", "H18", null, "Mrs Okon, I am also going to try to press your stomach. Please tell me if it hurts and where it hurts.", "talk"],
  ["H19", "H19", null, "Also, can you lift your right leg for me? Oh, it seems to be painful. Okay, that is fine.", "talk"],
  ["H20", "H20", null, "Okay, Mrs Okon, we are just going to try to keep you stable, but we will have to keep you for tonight and watch you closely. If you are stable tomorrow we will move you to one of the medical wards.", "talk"],
  ["H21", "H21", null, "She has a pulse of one hundred and four, and her blood pressure is one sixty over a hundred. This is quite high.", "documentation", "the request to chart became a report"],
  ["H22", "H22", null, "Her blood pressure is also about one sixty over a hundred. This is high.", "documentation", "the wake word and the request to record were dropped, so it is a finding"],
  ["H23", "H23", null, "We may need to do a mini surgery for her. Please prepare the mini theatre and call the anaesthetist. Quickly, quickly.", "instruction"],
  ["H24", "H24", null, "Oh, please forgive me, I think the last entry was wrong. I think the temperature is about thirty eight point five instead. Yeah, I think that is wrong.", "instruction"],
  ["H25", "H25", null, "Give her five hundred milligrams of paracetamol now. Give her five hundred milligrams of paracetamol now.", "instruction"],
  ["H26", "H26", null, "Okay, I think we should start metronidazole as well.", "talk"],
  ["H27", "H27", null, "Um, please, I think we need to send her for an abdominal X-ray. It is very important, but let us keep her stable first.", "talk"],
  ["H28", "H28+H29", [2.0, 5.6], "Doctor, her pulse is now one hundred and twelve.", "documentation"],
  ["H29", "H28+H29", [5.6, 11.78], "Hmm, the blood pressure, last I checked, is about ninety over sixty.", "documentation"],
  ["H30", "H30+H31+H32", [1.2, 6.5], "She also has two hundred mils of urine since midnight.", "documentation"],
  ["H31", "H30+H31+H32", [7.4, 10.3], "And I think her current temperature is thirty eight point two.", "documentation", "the request to chart became a report"],
  ["H32", "H30+H31+H32", [10.9, 18.3], "We need to add a care, we need to update her care plan for four hourly observations. We need to try and observe the patient every four hours.", "instruction", "the wake word was dropped"],
  ["X01", "H33+H34", [0.0, 6.6], "On a scale of one to ten, how much is the pain as I am touching here, as I am touching this side?", "talk", "the owner's added question, kept for the voice check only"],
  ["H33", "H33+H34", [8.2, 9.9], "Doctor, that would be about seven.", "talk"],
  ["H34", "H33+H34", [12.0, 20.91], "And before now I even tried to take, my brother gave me metformin, five hundred twice a day.", "talk"],
  ["H35", "H35+H36", [2.9, 5.85], "The fever has been on and off for one week.", "talk"],
  ["H36", "H35+H36", [5.85, 9.22], "But it hurts more when I breathe in.", "talk"],
  ["H37", "H37+H38", [2.3, 4.95], "I fainted at the market on Tuesday.", "talk"],
  ["H38", "H37+H38", [5.05, 6.75], "Well, my pain is better now.", "talk", "the request to write it down was dropped, so it is patient talk"],
  ["H40", "H40+H41", [1.3, 5.9], "And doctor, he has been managing diabetes for ten years.", "talk"],
  ["H41", "H40+H41", [6.4, 13.23], "She was so confused this morning, she did not even know my name. Can you imagine, doctor?", "talk"],
  ["H42", "H42", null, "Doctor, I hope she will not need any surgery. I hope she will not need any surgery.", "talk"],
  ["H43", "T24+H43", [8.3, 23.64], "Okay, chart the pulse as ninety. Chart the pulse as ninety. [P] It has been hurting since morning.", "instruction"],
  ["H45", "H45+H46", [0.0, 14.9], "Her blood pressure is even one fifty over ninety five. [S] Yes, go on. Okay, the hospital is just busy today.", "documentation", "the request to chart became a report"],
  ["H46", "H45+H46", [14.9, 22.44], "Um, I think we need to invite the surgical team to come and review this afternoon.", "talk", "a suggestion now, like H26"],
  ["H47", "H47", null, "Doctor, can I go home please? I want to go home today, oh please. [S] Do not worry, let us just get you stable. Let me finish this and get the surgical team to come and review your case.", "talk"],
  ["H48", "H48", null, "[S] Doctor, please, what is the sugar? Oh no, sorry, I did not mean doctor, I mean nurse. Nurse, what is the sugar? [N] Doctor, it is about four point two. [S] Okay, that is fine, thank you.", "documentation", "the owner speaks first, so the first voice is not the nurse"]
];

const byId = new Map(LINES.map((l) => [l.id, l]));
const normal = (s: string) => s.toLowerCase().replace(/\[[a-z]\]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Lines whose words no longer fit the scripted addressee: the script's label is kept, as the brief asks, and the doubt is marked.
const ADDRESSEE_DOUBT = new Set(["T18", "H21", "H22", "H23", "H31", "H32", "H38", "H45", "H46"]);

// Lines where the two transcribers and the script do not settle some of the words, kept out of the word error count.
export const UNSURE = new Set(["E1", "H07", "H08", "H12", "H17", "H37", "H43", "H45", "H47", "T14"]);

// The clinical values said in each line, as the normaliser should give them.
export const VALUES: Record<string, string[]> = {
  T01: ["92"], T02: ["130", "85"], T11: ["38.1"], T14: ["94"], T22: ["20"], T23: ["110"],
  H01: ["37.8"], H02: ["88", "18"], H03: ["140", "90"], H04: ["96"], H21: ["104", "160", "100"], H22: ["160", "100"], H24: ["38.5"], H25: ["500"],
  H28: ["112"], H29: ["90", "60"], H30: ["200"], H31: ["38.2"], H34: ["500"], H43: ["90"], H45: ["150", "95"], H48: ["4.2"]
};

export const REAL: readonly RealClip[] = ROWS.map(([id, source, cut, said, kind, note]) => {
  const l = byId.get(id);
  const set = /^E/.test(id) ? "enrolment" : /^X/.test(id) ? "extra" : l!.set;
  const who = l?.who ?? "S";
  return {
    id, set, source, start_s: cut?.[0] ?? null, end_s: cut?.[1] ?? null, who, addressee: l?.addressee ?? (id.startsWith("X") ? "patient" : null),
    kind, said, kind_changed: !!l && kind !== l.kind, addressee_doubt: ADDRESSEE_DOUBT.has(id), note: note ?? null
  };
});

// The scripted lines Samuel did not record.
export const MISSING = LINES.filter((l) => !l.synthetic_only && !REAL.some((c) => c.id === l.id)).map((l) => l.id);
export const scriptWords = (id: string): string | null => byId.get(id)?.words ?? null;
export { normal };
