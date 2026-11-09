"""Limited-batch GPU smoke test for Referee training adapters."""

from __future__ import annotations

from pathlib import Path

import lightning as L

try:
    from .dataset import RefereeDataModule
    from .module import RefereeViTModule
except ImportError:
    from dataset import RefereeDataModule
    from module import RefereeViTModule

PREPARED_DIR = (
    Path(__file__).resolve().parents[1] / "data" / ".local" / "data" / "sample" / "prepared"
)


def run_smoke_test() -> None:
    print("Initializing Referee DataModule...")
    dm = RefereeDataModule(
        prepared_dir=str(PREPARED_DIR),
        batch_size=4,
        num_workers=0,
    )
    dm.setup("fit")

    print("Initializing Referee ViT-Tiny LightningModule...")
    model = RefereeViTModule(num_classes=4)

    print("Setting up limited-batch Lightning Trainer...")
    trainer = L.Trainer(
        max_epochs=1,
        accelerator="gpu",
        devices=1,
        limit_train_batches=1,
        limit_val_batches=1,
        enable_checkpointing=False,
        logger=False,
    )

    print("Running sanity check fit loop (1 train batch, 1 val batch)...")
    trainer.fit(model, datamodule=dm)
    print("Referee smoke test passed successfully.")


if __name__ == "__main__":
    run_smoke_test()