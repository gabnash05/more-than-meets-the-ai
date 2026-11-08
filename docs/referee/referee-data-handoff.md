# Referee data handoff for the model owner

For wiring, use `trainer-sample.zip` and its entry in `checksums.json`. The [offline example](../../models/referee/data/README.md#setup-and-offline-example) generates a synthetic smoke package. For a real experiment, use `trainer-train.zip` with a verified trainer-ready summary after the multiclass run. The sample package only exercises the reader and shapes.

Copy the [trainer quick-start commands](../../models/referee/data/RUNBOOK.md#model-trainer-quick-start) to verify the ZIP, extract it and load a row in PowerShell.

## Read a sample in your model code

Use the extracted folder as your working directory. It contains `prepared/`, `labels.json`, `dataset-summary.json`, and the locked Python 3.13 reader with its Guesser preprocessing source.

~~~python
from referee_data import IndexedCanvases

canvases = IndexedCanvases("prepared", "train")
sample = canvases[0]

image = sample["image"]           # float32 [3, 224, 224] when status == "ok"
target = sample["target"]         # float32 [2], order [text, number]
known = sample["known_mask"]      # bool [2], same order
~~~

Change `"train"` to `"validation"` for the other trainer split. Use usable images and apply the mask independently to each target. Unknown slots carry finite zero placeholders with mask false. An all-unknown row contributes no supervision. `blank` and `uncertain` rows have no image tensor and remain visible in coverage counts. The loader already applies the shared normalization. Add standard framework batching in your model project.

## Record the package used

Record the dataset ID, profile, label order and preprocessing fingerprint from `dataset-summary.json` with the experiment. The Validation & Inference owner keeps the separate held-out ZIP. Both owners use the same dataset ID and reader.

If usable support is short for either head, send the summary to the Data owner. That owner can review additional candidates, rebuild the package and issue a fresh checksum.
