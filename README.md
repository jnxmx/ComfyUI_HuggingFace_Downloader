# ComfyUI HuggingFace Downloader

The **ComfyUI HuggingFace Downloader** is a custom node extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), designed to streamline the process of downloading models, checkpoints, and other resources from the Hugging Face Hub directly into your `models` directory. This tool simplifies workflow integration by providing a seamless interface to select and download required resources.

## Features

  - Allows you to specify links to files and folders/repos on the Hugging Face Hub.
  - Dropdown selection for model types prioritizes commonly used folders.
  - Handles multiple inputs and downloads all specified files.
  - Supports authentication via Hugging Face tokens for private repositories.

## Installation

1. Clone the repository into the `custom_nodes` directory of your ComfyUI installation:
   ```
   cd custom_nodes
   git clone https://github.com/jnxmx/ComfyUI_HuggingFace_Downloader.git
   ```
2. Restart ComfyUI.

## Usage

1. Use the `HuggingFace Model Selector` node to specify:
   - Links to files or folders.
   - Desired model type (e.g., `vae`).
2. Execute the workflow to download the resources.

## AI's Role in Development

ChatGPT was instrumental in the development of this project. 

## Contributing

Contributions are welcome! If you encounter issues or have suggestions for improvements, please open an issue or submit a pull request.


