const text = "Invalid or missing Hugging Face token for repository 'black-forest-labs/FLUX.2-klein-base-9b-fp8'. Please add a valid token in the ComfyUI settings or set the HF_TOKEN environment variable. You can create or manage your tokens at https://huggingface.co/settings/tokens/";
const urlRegex = /(https?:\/\/[^\s]+)/g;
const parts = text.split(urlRegex);
console.log("parts:", parts);
for (const part of parts) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}
