import { test, expect } from '@playwright/test';

const prefix = '/ChemPhys_7TH_Platform/';
const sizes = [[1366, 768], [1920, 1080], [768, 1024], [390, 844]];
const stages = ['التهيئة والاستكشاف', 'اكتشف المفهوم', 'المختبر التفاعلي', 'افهم وتحقق', 'طبّق', 'اختبر نفسك', 'ملخص'];

for (const [width, height] of sizes) {
  test(`production at Pages path: ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = [];
    const failedResponses = [];
    const resources = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedResponses.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== 'http://127.0.0.1:4175') {
        failedResponses.push(`unexpected external resource: ${url.origin}`);
      } else {
        if (response.status() >= 400) failedResponses.push(`${response.status()} ${url.pathname}`);
        if (!url.pathname.startsWith(prefix)) failedResponses.push(`outside Pages base: ${url.pathname}`);
        resources.push(url.pathname);
      }
    });
    await page.goto(prefix, { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('المعرفة تبدأ');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('المعرفة تبدأ');

    async function noOverflow() {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    }
    async function checkContactBars() {
      const bars = page.locator('.contact-strip');
      await expect(bars).toHaveCount(2);
      for (const [index, position] of ['top', 'bottom'].entries()) {
        const bar = page.locator(`.contact-strip--${position}`);
        const link = bar.locator('.contact-strip-link');
        const number = link.locator('.contact-strip-number');
        await expect(bar).toBeVisible();
        await expect(bar).toHaveAttribute('dir', 'rtl');
        await expect(bar).toHaveCSS('position', 'fixed');
        await expect(bar.locator('.contact-strip-name')).toHaveText('المهندس سومر شاهين');
        await expect(bar.locator('.contact-strip-name')).toHaveAttribute('dir', 'rtl');
        await expect(bar.locator('.contact-strip-name')).toHaveCSS('direction', 'rtl');
        await expect(number).toHaveText('0930215022');
        await expect(number).toHaveAttribute('dir', 'ltr');
        await expect(number).toHaveCSS('direction', 'ltr');
        await expect(link).toHaveAttribute('href', 'https://wa.me/963930215022');
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(bar.locator('.whatsapp-logo')).toHaveAttribute('aria-label', 'WhatsApp');
        await expect(bar.locator('.whatsapp-logo path')).toHaveAttribute('d', /M17[.]472/);
        await expect(bar).toHaveAttribute('aria-label', `شريط التواصل ${index === 0 ? 'العلوي' : 'السفلي'}`);
      }
      const destinations = await page.locator('.contact-strip-link').evaluateAll(links => links.map(link => {
        const url = new URL(link.href);
        return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname, search: url.search };
      }));
      expect(destinations).toEqual([
        { protocol: 'https:', hostname: 'wa.me', pathname: '/963930215022', search: '' },
        { protocol: 'https:', hostname: 'wa.me', pathname: '/963930215022', search: '' },
      ]);
      const reservedTopSpace = await page.evaluate(() => ({
        headerDocumentTop: document.querySelector('.topbar').getBoundingClientRect().top + window.scrollY,
        contactHeight: document.querySelector('.contact-strip--top').getBoundingClientRect().height,
      }));
      expect(reservedTopSpace.headerDocumentTop).toBeGreaterThanOrEqual(reservedTopSpace.contactHeight);
    }
    async function checkFixedContactBars() {
      await page.evaluate(async () => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const geometry = await page.evaluate(() => ({
        top: document.querySelector('.contact-strip--top').getBoundingClientRect().top,
        bottom: document.querySelector('.contact-strip--bottom').getBoundingClientRect().bottom,
        bottomBarTop: document.querySelector('.contact-strip--bottom').getBoundingClientRect().top,
        viewportHeight: innerHeight,
        footerBottom: document.querySelector('.footer').getBoundingClientRect().bottom,
      }));
      expect(geometry.top).toBe(0);
      expect(geometry.bottom).toBe(geometry.viewportHeight);
      expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.bottomBarTop);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    async function go(name) {
      if (width <= 760) await page.locator('[data-action="menu"]').click();
      await page.locator(`.nav-item[data-page="${name}"]`).click();
      await checkContactBars();
      await noOverflow();
    }

    await checkContactBars();
    await noOverflow();
    await checkFixedContactBars();
    await noOverflow();
    await go('subjects');
    await expect(page.locator('.unified-subject')).toHaveCount(1);
    await expect(page.locator('.unified-subject h2')).toHaveText('الفيزياء والكيمياء');
    await expect(page.locator('.subject-card')).toHaveCount(0);
    await go('unit');
    await go('lesson');
    await expect(page.locator('.stage-list [data-stage]')).toHaveCount(7);
    for (let i = 0; i < stages.length; i++) {
      await page.locator(`[data-stage="${i}"]`).click();
      await expect(page.locator('.lesson-intro h2')).toHaveText(stages[i]);
      await checkContactBars();
    }
    await expect(page.locator('.formula-example .katex-mathml')).toHaveCount(3);
    await expect(page.locator('.formula-example .mfrac')).toBeVisible();
    await expect(page.locator('.formula-example .quantity')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('.formula-example .quantity')).toHaveText('20 m');
    await page.locator('[data-action="next"]').click();
    await expect(page.locator('.notebook-intro h2')).toHaveText('دفتر الطالب');
    await expect(page.locator('.notebook-block')).toHaveCount(6);
    await checkContactBars();
    await noOverflow();
    await page.locator('[data-action="prev"]').click();
    await checkContactBars();
    for (const direction of ['left', 'right']) {
      await page.locator(`[data-direction="${direction}"]`).click();
      for (const value of [1, 5]) {
        await page.locator('#force').fill(String(value));
        const coordinates = await page.locator('.vector-svg line[stroke="#167c82"]').evaluate(element => [Number(element.getAttribute('x1')), Number(element.getAttribute('x2'))]);
        expect(coordinates).toEqual([180, 180 + (direction === 'left' ? -1 : 1) * value * 30]);
      }
    }

    await go('exams');
    await expect(page.locator('.locked-tile')).toContainText('غير منشأ');
    await page.locator('[data-action="check"]').click();
    await expect(page.locator('.feedback')).toContainText('اختر');
    await page.locator('[data-answer="0"]').click();
    await page.locator('[data-action="check"]').click();
    await expect(page.locator('.feedback')).toContainText('حاول');
    await page.locator('[data-answer="1"]').click();
    await page.locator('[data-action="check"]').click();
    await expect(page.locator('.feedback')).toContainText('موفق');
    await page.locator('[data-exam-tab="solutions"]').click();
    await checkGate('solutions');
    await expect(page.locator('.empty-state')).toContainText('لا توجد');
    await noOverflow();
    await page.locator('[data-lock="solutions"]').click();
    await expect(page.locator('#password-solutions')).toBeVisible();

    await go('teacher');
    await checkGate('teacher');
    await expect(page.locator('.placeholder-grid div')).toHaveCount(6);
    await expect(page.locator('.empty-state')).toContainText('لا توجد حلول');
    await noOverflow();
    await page.locator('[data-lock="teacher"]').click();
    await expect(page.locator('#password-teacher')).toBeVisible();

    await go('colors');
    await expect(page.locator('.swatch-card')).toHaveCount(7);
    await go('fonts');
    const fontStatus = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('400 18px "Noto Sans Arabic"', 'العلم'),
        document.fonts.load('400 18px "Cairo"', 'العلم'),
        document.fonts.load('400 18px KaTeX_Main', '123'),
      ]);
      return [document.fonts.check('400 18px "Noto Sans Arabic"', 'العلم'), document.fonts.check('400 18px "Cairo"', 'العلم'), document.fonts.check('400 18px KaTeX_Main', '123')];
    });
    expect(fontStatus).toEqual([true, true, true]);
    await expect(page.locator('.noto .specimen p').first()).toHaveCSS('font-family', /Noto Sans Arabic/);
    await expect(page.locator('.cairo .specimen p').first()).toHaveCSS('font-family', /Cairo/);
    expect(resources.some(url => /noto-sans-arabic-arabic.*\.woff2/.test(url))).toBeTruthy();
    expect(resources.some(url => /cairo-arabic.*\.woff2/.test(url))).toBeTruthy();
    expect(resources.some(url => /KaTeX_Main-Regular.*\.woff2/.test(url))).toBeTruthy();
    expect(resources.some(url => /\.js$/.test(url))).toBeTruthy();
    expect(resources.some(url => /\.css$/.test(url))).toBeTruthy();
    expect(failedResponses).toEqual([]);
    expect(errors).toEqual([]);

    async function checkGate(kind) {
      await expect(page.locator('.security-note')).toContainText('ليست حماية أمنية');
      await page.locator(`form[data-gate="${kind}"] button`).click();
      await expect(page.locator(`#gate-help-${kind}`)).toContainText('أدخل');
      await page.locator(`#password-${kind}`).fill('wrong');
      await page.locator(`form[data-gate="${kind}"] button`).click();
      await expect(page.locator(`#gate-help-${kind}`)).toContainText('غير صحيحة');
      await page.locator(`#password-${kind}`).fill('somer173');
      await page.locator(`form[data-gate="${kind}"] button`).click();
    }
  });
}
