# Project Digital Employee WeChat Article Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the existing digital employee management article into a practical, evidence-backed article explaining why project-group digital employees may emerge first in 2026 H2 and how AIPRO should implement and scale them.

**Architecture:** Reuse the existing mobile HTML, Canvas rendering, rich-text copy, QA, and WeChat draft pipeline. Create a new article version so the already-created draft remains intact; preserve AIPRO's local runtime and identity boundaries while adding the project collaboration capability model and a two-stage evolution toward the enterprise control plane.

**Tech Stack:** HTML, browser Canvas, Playwright QA, WeChat official draft API, Node.js ESM.

---

### Task 1: Extract the article thesis and evidence map

**Files:**
- Read: `/Users/Administrator/.codex/attachments/b9d90ff9-a1e5-4812-8857-8ba7ecbab780/pasted-text.txt`
- Read: `outputs/公众号_为什么企业需要数字员工管理平台.html`
- Create: `outputs/公众号_下半年项目数字员工可能先爆发_参考线.md`

**Steps:**
1. Extract stable historical viewpoints and the new project collaboration capabilities.
2. Separate market evidence from AIPRO pilot targets.
3. Map each strong claim to an official primary source.
4. Record the two-stage evolution and non-conflict explanation.

### Task 2: Write the upgraded article

**Files:**
- Create: `outputs/公众号_下半年项目数字员工可能先爆发.html`

**Steps:**
1. Open with a concrete project-group failure loop.
2. Explain the four conditions making the direction plausible in 2026 H2.
3. Define the project digital employee and its complete work loop.
4. Describe AIPRO's preserved foundation and six added capabilities.
5. Add a realistic end-to-end project feedback example.
6. Add the phased pilot, capability gates, metrics, and explicit no-go list.
7. Close with the two-stage evolution to the enterprise control plane and a natural CTA.

### Task 3: Rebuild Canvas visuals

**Files:**
- Modify: `outputs/公众号_下半年项目数字员工可能先爆发.html`

**Steps:**
1. Render no more than 12 Canvas PNG images at DPR=3.
2. Check every image for overflow, fragmented Chinese lines, and line intersections.
3. Produce a visual contact sheet for manual inspection.

### Task 4: Verify rich-text copy

**Files:**
- Create: `outputs/公众号_下半年项目数字员工可能先爆发_QA.mjs`

**Steps:**
1. Render the HTML in Playwright and wait for all Canvas images.
2. Verify all article images are `data:image/png`.
3. Verify copied HTML has inline styles and no class/id dependency.
4. Render copied HTML in a blank page and verify title, line height, image width, captions, and author card.
5. Save preview, contact sheet, and blank-copy screenshots.

### Task 5: Push a new WeChat draft

**Files:**
- Read: `outputs/公众号_下半年项目数字员工可能先爆发.html`

**Steps:**
1. Run `doctor` with the Codex runtime.
2. Run `dry-run` and verify title, 80–120 character digest, and image list.
3. Run `push` to create a new draft; do not publish or mass-send.
4. Record the returned `media_id` in the delivery receipt.

