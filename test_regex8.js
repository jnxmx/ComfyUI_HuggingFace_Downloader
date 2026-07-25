const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
const parts = "The repository 'black-forest-labs/FLUX.1-dev' is gated or you do not have permission to access it.\nVisit https://huggingface.co/black-forest-labs/FLUX.1-dev, accept its terms or request access, then retry the download.".split(urlRegex);

for (const part of parts) {
    if (urlRegex.test(part)) {
        console.log("URL:", part);
    } else {
        console.log("TEXT:", part);
    }
}
