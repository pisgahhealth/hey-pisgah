# Third-party notices

Built with Muse Spark Open.

None of the models below is bundled in this repository. The local models and the sherpa-onnx runtime are downloaded at setup. Licences were checked against the sources linked.

## Models

| What | Used for | Licence | Source |
| --- | --- | --- | --- |
| Muse Spark Open (Meta), served on Modal | Decides what each spoken line asks the agent to do, and what to ask back | Muse Spark Open licence, which asks for "Built with Muse Spark Open" to be shown | [licence](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md) |
| Meta Voice Transcribe, through the Meta Model API | Turns the clinician's speech into text, over REST or realtime | Meta Model API terms and acceptable-use policy | [terms](https://dev.meta.ai/legal/terms-of-service), [policy](https://dev.meta.ai/legal/acceptable-use-policy) |
| Kroko English streaming Zipformer, community model (Banafo) | Optional local streaming ear | CC-BY-SA (the model card does not state a version) | [model card](https://huggingface.co/Banafo/Kroko-ASR) |
| NVIDIA Parakeet TDT 0.6B v2, int8 | Optional local second ear | CC-BY-4.0 | [model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) |
| NVIDIA TitaNet-small | Local speaker model: who probably spoke, never a credential | Covered by the NeMo Toolkit licence, Apache-2.0 | [model card](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small), [NeMo licence](https://github.com/NVIDIA/NeMo/blob/main/LICENSE) |
| GigaSpeech keyword-spotting Zipformer 3.3M (k2-fsa) | Local wake-phrase spotter in the browser | Apache-2.0 | [release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models) |

Kroko, Parakeet and TitaNet run through sherpa-onnx in the onnx format k2-fsa publishes. The CC-BY-SA licence of the Kroko model applies to that model and anything derived from it; this repository holds no copy of it.

## Runtime

| What | Used for | Licence | Source |
| --- | --- | --- | --- |
| sherpa-onnx and sherpa-onnx-node (k2-fsa) | Runs the local ears, the speaker model and the wake spotter | Apache-2.0 | [repository](https://github.com/k2-fsa/sherpa-onnx) |

## Design references

- meta-models/meta-model-cookbook (MIT): agent loop basics, managing context, alert fatigue copilot, append-only audit log, deterministic replay, goal tracking. Used as design references; see docs/CONTRIBUTIONS.md.
