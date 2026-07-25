const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const parts = "Tokens at https://huggingface.co/settings/tokens/ here.".split(urlRegex);

for (const part of parts) {
    if (urlRegex.test(part)) {
        console.log("URL:", part);
    } else {
        console.log("TEXT:", part);
    }
}
