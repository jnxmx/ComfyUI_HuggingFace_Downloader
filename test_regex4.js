const text = "https://a.comhttps://b.com";
const urlRegex = /(https?:\/\/[^\s]+)/g;
const parts = text.split(urlRegex);
console.log("parts:", parts);
for (const part of parts) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}

const text2 = "https://a.com https://b.com";
const parts2 = text2.split(urlRegex);
console.log("\nparts2:", parts2);
for (const part of parts2) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}

const text3 = "https://a.com  https://b.com";
const parts3 = text3.split(urlRegex);
console.log("\nparts3:", parts3);
for (const part of parts3) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}
