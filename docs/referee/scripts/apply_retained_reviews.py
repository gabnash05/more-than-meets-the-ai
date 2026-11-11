"""Merge matching retained multiclass reviews into a staged profile."""

import argparse
import json
from pathlib import Path


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    args = parser.parse_args()
    profile = args.profile
    ids = {row["sample_id"] for row in read_rows(profile / "source" / "pairs.jsonl")}
    output = profile / "corrections.jsonl"
    existing = read_rows(output) if output.exists() else []
    merged = {row["sample_id"]: row for row in existing}
    if len(merged) != len(existing):
        raise ValueError("Existing corrections contain duplicate sample IDs")
    reviews_dir = Path(__file__).resolve().parent.parent / "reviews"
    added = 0
    for name in ("sample-corrections-20261111.jsonl", "retained-multiclass-corrections-20261111.jsonl"):
        for row in read_rows(reviews_dir / name):
            sid = row["sample_id"]
            if sid not in ids:
                continue
            if sid in merged:
                if merged[sid] != row:
                    raise ValueError(f"Existing correction differs for {sid}; resolve manually")
                continue
            merged[sid] = row
            added += 1
    content = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in merged.values())
    output.write_text(content, encoding="utf-8")
    print(f"Added {added} matching retained reviews; {len(merged)} total corrections")


if __name__ == "__main__":
    main()
