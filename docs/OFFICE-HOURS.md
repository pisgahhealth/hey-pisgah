# Office hours and organiser questions

Samuel fills in "Asked on" and "Answered on".
Every fact below was checked on 28 Oct 2026.
A fact marked "unverified" was not found on any official page.

## Schedule

| Item | When | Source | Status |
|---|---|---|---|
| Workshops from Meta and partners, office hours on Discord | 27 Oct to 4 Nov | [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) | Verified |
| Meta workshops | Tue 27 and Wed 28 Oct, noon ET | Kickoff stream | Unverified, not on either event page |
| Fireworks workshop with Sinan Ozdemir | Fri 30 Oct | The event page names the workshop, not the date | Date unverified |
| Meta office hours | Weekday mornings ET | Kickoff stream | Times unverified |
| Submissions due | 4 Nov, 9:00 PM ET | [Meta event page](https://dev.meta.ai/events/global-hackathon), event page | Verified |
| Judging | 4 to 8 Nov | Both pages | Verified |
| Winners announced | 9 Nov | Both pages | Verified |

## Credits

| Partner | Amount | Source | Status |
|---|---|---|---|
| Baseten | $100 and 2M tokens per minute | Event page | Verified |
| Modal | $100 | Event page | Verified |
| Fireworks | $100 | Event page | Verified; one third-party summary says $25 |
| Meta Model API | $150 each | Third-party write-ups | Unverified |

No credit claim form is linked on either event page.

## Organiser questions

| # | Question | Why it matters to us | Asked on | Answered on | Answer and source |
|---|---|---|---|---|---|
| O1 | Is a hospital operations agent that performs staff-directed tasks and tests process improvements eligible under the medical-advice exclusion? | Our whole entry depends on it. | | | Open. Neither event page mentions a medical exclusion. Official rules not found. |
| O2 | Is entering an order exactly as a clinician instructed permitted? | It is the core action the agent takes. | | | Open. Same as O1. |
| O3 | Does a separate public hey-pisgah repo with a synthetic simulator, evaluator and documented adapters satisfy review? | Our real system stays private. | | | Open. Not covered on either page. |
| O4 | Is a particular licence required for the repo? | We must choose one before we submit. | | | Open. Not covered on either page. |
| O5 | Can a startup-track prize combine with bonus awards? | It changes which awards we aim for. | | | Open. Third-party sites say bonus prizes total up to $50,000 (unverified). |
| O6 | Which time zone governs the 8 Nov end-of-day cutoff for X engagement? | We need the exact cutoff time. | | | Open. Not on either page. |
| O7 | Is there an earlier deadline to submit the post link? | We might miss it. | | | Open. Not on either page. |
| O8 | What evidence does the infrastructure partner need to verify open-weight inference? | We must collect it while we build. | | | Open. Not on either page. |
| O9 | What are the community vote amount, cutoff and rules? | We need to plan outreach. | | | Open. Third-party sites mention a public-vote bonus announced around 10 Nov (unverified). |

## Technical questions

| # | Question | Why it matters to us | Asked on | Answered on | Answer and source |
|---|---|---|---|---|---|
| T1 | Any tips for reliable Spark Open tool calls on partner endpoints? | Failed tool calls break the agent loop. | | | Partly known. The model card suggests temperature 1.0, top_p 1.0, reasoning_effort xhigh by default. Reasoning and the answer share max_tokens. Sources: [model card](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B), [Meta deploy doc](https://dev.meta.ai/docs/muse-spark-open/deploy). |
| T2 | Which partner routes enforce json_schema? | We rely on strict output. | | | Baseten accepts json_schema but does not enforce it ([Baseten](https://docs.baseten.co/inference/structured-outputs)). Groq lists Muse Spark Open for strict mode; the model is in preview with 131,072 tokens of context ([Groq strict](https://console.groq.com/docs/structured-outputs), [Groq model](https://console.groq.com/docs/model/meta-models/muse-spark-open)). Fireworks enforces json_schema but turns reasoning output off ([Fireworks](https://docs.fireworks.ai/structured-responses/structured-response-formatting)). Modal: not documented. |
| T3 | Are request ids from Baseten, Modal or Fireworks acceptable evidence for the open-weight award? | They are the cheapest evidence to keep. | | | Open. Not found in any doc. |
| T4 | Does inference on a partner count for the open-weight award, or must we self-host? | It decides where we run the model. | | | Open. Not found. |
| T5 | What satisfies the "Built with Muse Spark Open" label under the Muse Model License? | It is a licence condition. | | | The model card says to show it in the UI, the docs or a settings menu ([model card](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)). Ask whether a README line plus a demo footer is enough. |
| T6 | Which Modal model id is correct? | A wrong id fails every call. | | | Modal's CLI created our shared endpoint as `meta-models/Muse-Spark-Open-816B-A42B`, which matches the [Modal library page](https://modal.com/library/meta/muse-spark-open). The event email said `meta-models/muse-spark-open-1026`. Other partners use `meta-models/muse-spark-open` ([Meta deploy doc](https://dev.meta.ai/docs/muse-spark-open/deploy)). |
| T7 | Does the Modal hackathon $100 cover Shared Endpoints? | We may be paying from the first token. | | | Open. Modal's docs say plan credits cannot be used for Shared Endpoint usage ([Modal](https://modal.com/docs/guide/shared-endpoints)). Price is $1.25 in, $0.15 cached and $4.25 out per million tokens ([library page](https://modal.com/library/meta/muse-spark-open)). |
| T8 | How well does Voice Transcribe handle Nigerian English and Pidgin? | Our users speak both. | | | Open. Meta lists 25 validated languages out of 70+ trained, none Nigerian, and advises testing your own accents ([Meta blog](https://dev.meta.ai/resources/blog/meet-muse-voice-transcribe-streaming-speech-to-text/), [research blog](https://research.meta.ai/blog/introducing-muse-voice-transcribe)). |
| T9 | Is reasoning_content sent back on earlier turns rendered into the prompt on Baseten? | It affects cost and behaviour. | | | Open. Baseten says to keep it on earlier turns but does not say whether it is rendered ([Baseten](https://docs.baseten.co/inference/model-apis/reasoning)). |
| T10 | How many GitHub Actions minutes does a public org repo get? | CI runs on every push. | | | Free on standard runners for public repos ([GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). |
