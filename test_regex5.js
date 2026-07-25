const urlRegex = /(https?:\/\/[^\s]+)/g;

function renderErrorWithLinks(text) {
    if (!text) return;
    const parts = text.split(urlRegex);
    console.log("parts:", parts);
    for (const part of parts) {
        if (urlRegex.test(part)) {
            console.log("LINK:", part);
        } else {
            console.log("TEXT:", part);
        }
    }
}

renderErrorWithLinks("The repository 'black-forest-labs/FLUX.1-dev' is gated or you do not have permission to access it.\nVisit https://huggingface.co/black-forest-labs/FLUX.1-dev, accept its terms or request access, then retry the download.");
