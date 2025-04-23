# ComfyUI Hugging Face Downloader

This repository provides custom nodes for ComfyUI that enable seamless downloading of models and folders from Hugging Face using a fast and efficient library. These nodes are designed to integrate smoothly into your workflows.

## Features

- **Fast Downloads**: Utilizes the `huggingface_hub` library for quick and reliable downloads.
- **Flexible Outputs**: The `model_name` output from these nodes can be connected to any other node in your workflow, enabling dynamic and modular pipeline construction.
- **Customizable**: Supports downloading to predefined folders or custom paths.

## Nodes

### Hugging Face Download Model
- Downloads a single file from a Hugging Face repository.
- Outputs the `model_name`, which can be used as input for other nodes.

### Hugging Face Download Folder
- Downloads an entire folder or subfolder from a Hugging Face repository.
- Outputs the `folder name`, which can be connected to other nodes.

## Usage

1. Add the nodes to your workflow in ComfyUI.
2. Configure the required inputs, such as the Hugging Face link and target folder.
3. Connect the `model_name` or `folder name` output to any compatible node in your workflow.

## Notes

- To download from gated repositories, ensure you have a valid Hugging Face token configured in the settings or as an environment variable (`HF_TOKEN`).
- The nodes handle caching and cleanup automatically to optimize disk usage.
