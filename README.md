# Synapse 🧠

**Synapse** is a cognitive accessibility Chrome extension that leverages Anthropic's Claude to dynamically restructure, reformat, and summarize web content to perfectly match *your* unique brain and reading preferences.

Whether you need high-level bullet points, simplified language without jargon, or deep technical summaries, Synapse reconstructs the web for you in real-time.

## Features

- **Section Cards:** Subtly highlights readable sections of any webpage. Click a section to instantly generate a summarized, floating "cognitive card" tailored to your profile.
- **Full Page Reformat:** Restructures the entire webpage into an easy-to-read, clean layout based on your needs.
- **Document Reader:** Drag and drop or open any PDF, CSV, TXT, or Markdown file in Chrome to launch the Synapse Document Reader, which reformats dense documents for effortless consumption.
- **Continuous Learning:** Synapse learns from your feedback! Thumbs up or thumbs down the reformatted content, and the extension will automatically adjust your cognitive profile in the background.

---

## Installation Guide

Because Synapse is a developer project taking advantage of direct API access, it is currently side-loaded as an "unpacked extension". Follow these steps to get it running:

### 1. Add your Claude API Key
Before installing, you must provide your own Anthropic Claude API key.
1. Open the `background.js` file in a code editor.
2. Find line 4 at the top of the file:
   ```javascript
   const CLAUDE_API_KEY = "YOUR_API_KEY_HERE";
   ```
3. Replace the string with your active Claude API key and save the file. *(Note: Synapse uses the powerful Claude 3.5 Sonnet model and the new document processing beta).*

### 2. Install in Chrome
1. Open Google Chrome.
2. Type `chrome://extensions/` into the URL bar and hit Enter.
3. In the top right corner of the Extensions page, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button that appears in the top left.
5. Select the `Synapse OS` folder (the folder containing `manifest.json`, `background.js`, etc.) and click Select Folder.

Synapse is now installed! Pin it to your Chrome toolbar for easy access.

---

## 📖 How to Use

1. **Onboarding:** Click the Synapse extension icon in your Chrome toolbar. You will be greeted with a two-step setup to define your Reading Style, Detail Level, Structure, and Tone.
2. **Activate:** Open any article, webpage, or local document. You'll see the green Synapse action button (FAB) floating in the bottom-right corner. 
3. **Choose your Mode:**
   - Click the button to open the control panel.
   - Choose **Section Cards** and click the green button. Scroll the page—Synapse will draw subtle borders on the left side of paragraphs. Click any bordered paragraph to pull up a summary.
   - Choose **Full Page** and click the green button to transform the entire page at once.
4. **Documents:** Opening a local PDF in Chrome? Synapse will automatically detect it and offer a "Read PDF" button in the panel.

## 🛠 Tech Stack
- Vanilla JavaScript, HTML, CSS
- Chrome Extensions API Version 3 (`chrome.storage.local`, `chrome.runtime`)
- Anthropic API (`claude-3-5-sonnet-20241022`, including exact-document parsing beta headers).
