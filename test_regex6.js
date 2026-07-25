const urlRegex = /(https?:\/\/[^\s]+)/g;
console.log("Two adjacent:", "http://a.com http://b.com".split(urlRegex));
console.log("Consecutive:", "http://a.comhttp://b.com".split(urlRegex));
console.log("Normal:", "foo http://a.com bar http://b.com baz".split(urlRegex));
