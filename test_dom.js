const { JSDOM } = require("jsdom");
const dom = new JSDOM(`<!DOCTYPE html><div id="error"></div>`);
const document = dom.window.document;

const urlRegex = /(https?:\/\/[^\s]+)/g;
const renderErrorWithLinks = (container, text) => {
    container.innerHTML = "";
    if (!text) return;
    const parts = text.split(urlRegex);
    for (const part of parts) {
        if (urlRegex.test(part)) {
            const link = document.createElement("a");
            link.href = part;
            link.textContent = part;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            container.appendChild(link);
        } else {
            container.appendChild(document.createTextNode(part));
        }
    }
};

const errorContainer = document.getElementById("error");
const errorMsg = "Invalid or missing Hugging Face token for repository 'black-forest-labs/FLUX.1-dev'. Please add a valid token in the ComfyUI settings or set the HF_TOKEN environment variable. You can create or manage your tokens at https://huggingface.co/settings/tokens/";

renderErrorWithLinks(errorContainer, errorMsg);
console.log(errorContainer.innerHTML);

// Try again
renderErrorWithLinks(errorContainer, errorMsg);
console.log(errorContainer.innerHTML);

