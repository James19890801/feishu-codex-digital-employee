#!/usr/bin/env python3
"""Read-only Playwright smoke test for the dashboard IM channel controls."""

from playwright.sync_api import sync_playwright, expect


URL = "http://127.0.0.1:17655/"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text)
            if message.type == "error" else None)
    page.goto(URL)
    page.wait_for_load_state("networkidle")

    expect(page.locator("[data-channel-open]")).to_have_count(4)

    page.locator('[data-channel-open="feishu"]').click()
    expect(page.locator("#channelDialog")).to_be_visible()
    expect(page.locator("#channelDialogTitle")).to_have_text("飞书主通道")
    expect(page.locator("#channelEnabledRow")).to_be_hidden()
    expect(page.locator("#channelSaveButton")).to_be_disabled()
    page.locator("#channelTestButton").click()
    expect(page.locator("#channelValidationState")).to_contain_text("全部通过", timeout=12_000)
    page.locator("#channelDialogClose").click()

    page.locator('[data-channel-open="wecom"]').click()
    expect(page.locator('[data-channel-fields="wecom"]')).to_be_visible()
    expect(page.locator("#channelWecomCredentialState")).to_contain_text("尚未保存")
    expect(page.locator("#channelSaveButton")).to_have_text("保存配置")
    page.locator("#channelEnabled").check()
    expect(page.locator("#channelSaveButton")).to_have_text("保存并连接")
    page.locator("#channelEnabled").uncheck()
    page.locator("#channelDialogClose").click()

    page.locator('[data-channel-open="wechat"]').click()
    expect(page.locator('[data-channel-fields="wechat"]')).to_be_visible()
    expect(page.locator("#channelWechatCallback")).to_be_visible()
    expect(page.locator("#channelWechatCredential")).to_have_attribute("type", "password")
    page.screenshot(path="/tmp/aipro-im-channel-config.png", full_page=True)
    page.locator("#channelDialogClose").click()

    assert not console_errors, f"browser console errors: {console_errors}"
    browser.close()

print("DASHBOARD_CHANNEL_UI_SMOKE_OK")
