#!/usr/bin/env node
/**
 * Simple test script to render CommonMark content using the extension's rendering utilities
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

// Read the test markdown file
const markdownPath = resolve("./test-commonmark.md");
const markdown = readFileSync(markdownPath, "utf-8");

// Get the ANSI theme from pi-coding-agent
const theme = getMarkdownTheme();

// Create a Markdown instance and render
const md = new Markdown(markdown, 0, 0, theme);
const width = process.stdout.columns ?? 80;

console.log("=".repeat(width));
console.log("RENDERED COMMONMARK OUTPUT");
console.log("=".repeat(width));
console.log("");

const lines = md.render(width);
console.log(lines.join("\n"));

console.log("");
console.log("=".repeat(width));
