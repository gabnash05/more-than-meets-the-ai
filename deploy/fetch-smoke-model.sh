#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
revision=b02fde8d8732aed32bc9d8176c3dc4efda0333fb
base=https://huggingface.co/zarqankhn/quickdraw-345-tflite/resolve/$revision
root=${AI_ARTIFACT_DIR:-}
if [ -z "$root" ] && [ -f .env ]; then
  root=$(awk 'index($0, "AI_ARTIFACT_DIR=")==1 {sub(/^[^=]*=/,""); sub(/\r$/,""); print; exit}' .env)
fi
root=${root:-../.local/ai-artifacts}
target=$root/quickdraw-int8-smoke
model_hash=aa58c3f7b710dee642db88ef7d30b7a4feea9c25bbed24e75c66fe4cd53fb701
labels_hash=2ed0dac4ba018854a3e3166f9862e5529bc5f58a80d157d57eee22ca731895d5
metadata_hash=d600a87a4572896aeb9293c7712901539fbd9ed0beb8b81797c3459ebb69fb96
hashes="$model_hash  model.tflite
$labels_hash  labels.txt
$metadata_hash  model_metadata.json"
if [ -e "$target" ]; then
  (cd "$target" && printf '%s\n' "$hashes" | sha256sum -c --status && test -f manifest.json)
  printf '%s\n' 'Pinned smoke bundle already present.'
  exit 0
fi
mkdir -p -- "$root"
temporary=$(mktemp -d "$root/.quickdraw.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
curl -fsSL --retry 2 "$base/quickdraw_model_int8.tflite" -o "$temporary/model.tflite"
curl -fsSL --retry 2 "$base/labels.txt" -o "$temporary/labels.txt"
curl -fsSL --retry 2 "$base/model_metadata.json" -o "$temporary/model_metadata.json"
(cd "$temporary" && printf '%s\n' "$hashes" | sha256sum -c --status)
cat > "$temporary/manifest.json" <<EOF
{
  "version": 1,
  "role": "guesser",
  "modelId": "quickdraw-int8-smoke",
  "artifactRevision": "$revision",
  "adapter": "quickdraw-int8",
  "preprocessing": "quickdraw-white-strokes-v1",
  "input": [1, 28, 28, 1],
  "output": [1, 345],
  "files": {
    "model.tflite": "$model_hash",
    "labels.txt": "$labels_hash",
    "model_metadata.json": "$metadata_hash"
  }
}
EOF
cat > "$temporary/ATTRIBUTION.txt" <<EOF
Smoke-test artifact only.
Weights by zarqankhn, Apache-2.0. $base
Training source: https://github.com/KashifKhn/quickdraw-345-classifier
Google Quick, Draw! dataset, CC BY 4.0: https://github.com/googlecreativelab/quickdraw-dataset
EOF
chmod 644 "$temporary"/*
chmod 755 "$temporary"
mv -T -- "$temporary" "$target"
printf '%s\n' 'Installed the verified Quick, Draw! smoke bundle.'
