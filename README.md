# Hey Pisgah

**A personal agent that handles hospital tasks while clinicians talk through their work.**

Hey Pisgah runs inside the [Pisgah Health](https://pisgahhealth.com) EMR. It turns spoken instructions into notes, orders and coordinated work across departments, with the goal of taking an encounter from emergency arrival to discharge without constant typing and clicking.

[Watch the demo](https://youtu.be/JmE1d3voYg4) · [Review guide](docs/REVIEW.md) · **Built with Muse Spark Open** for the Meta Global AI Developer Hackathon

## What it does

- Registers arrivals, records notes, vitals and allergies, and sends clinician-directed orders to the laboratory and pharmacy.
- Coordinates admission, reviews, follow-ups, discharge paperwork and billing preparation.
- Keeps track of unfinished work, handles corrections and resumes interrupted tasks.
- Acts under its own agent identity on behalf of the clinician, checks permissions and reads records back before reporting a write as complete. Clinical decisions and required approvals stay with staff.

## An intelligence layer that learns from the work

The agent remembers preferences only after their owner approves the scope. Beyond that, an experimental investigator studies synthetic patient journeys, develops explanations for delays and tests possible improvements in a simulator. It proposes changes for approval, then checks whether they help on fresh cases and still fit another ward's requirements.

Remembering a preference, discovering an improvement and proving that it helps are evaluated separately. Simulation results are not evidence of savings in a real hospital.

**Muse Voice Transcribe** provides speech input, with vocabulary hints and additional speech checks. **Muse Spark Open**, served through **Modal**, powers interpretation, tool selection and investigation. Calls, latency and estimated cost are logged; no model was trained or fine-tuned for this project.

Built during the hackathon on top of the existing Pisgah EMR. See the [contribution map](docs/CONTRIBUTIONS.md) for what we added.

The demo uses fictional patients and simulated payments.

## Explore the code

- [Run the evaluation](docs/REVIEW.md#run-the-evaluation)
- [EMR integration](packages/pisgah-adapter/README.md)
- [Workflow investigator](packages/intelligence/README.md)
- [Model client and replay](packages/model/README.md)
- [Third-party models and licences](THIRD_PARTY_NOTICES.md)

Code: [MIT licence](LICENSE).
