# Format: only_text
 
- The **only_text** folder contains dataset for training canvasNet with only text class:
	- Each folder **train/test** inside **only_text** folder contains 3 type of files for each training sample:
		- **label_x.npy**: Contains the label for the xth training sample.
		- **sample_x.npy**: Contains the xth sample image in numpy matrix format.
		- **sample_x.png**: Contains the xth sample image in png image format.

# Format: multiclass

- The **multiclass** folder contains dataset for training canvasNet with only text class:
	- Folder **train** inside **multiclass** folder contains 5 sub-folders for each atypical category type(circle, number, symbol, text) and a **real** folder for non-augmented sessions, inside each of them:
		- **label_x.npy**: Contains the label for the xth training sample.
		- **sample_x.npy**: Contains the xth sample image in numpy matrix format.
		- **sample_x.png**: Contains the xth sample image in png image format.
	- Folder **test** inside **multiclass** folder contains 3 type of files for each training sample:
		- **label_x.npy**: Contains the label for the xth training sample.
		- **sample_x.npy**: Contains the xth sample image in numpy matrix format.
		- **sample_x.png**: Contains the xth sample image in png image format.