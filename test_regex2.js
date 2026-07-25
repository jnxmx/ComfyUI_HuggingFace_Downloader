const text = "Gated repository. Accept the model agreement on Hugging Face, then retry.";
const urlRegex = /(https?:\/\/[^\s]+)/g;
const parts = text.split(urlRegex);
console.log("parts:", parts);
for (const part of parts) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}
