import { test, expect, type Page, type Response } from '@playwright/test';
import { getDatabase } from '../src/lib/db';
import { getAllGames } from '../src/lib/games';
import type { Game } from '../src/types/game';

/**
 * Asserts the visible catalog's exact titles, IDs, ordering, and result count.
 *
 * @param page - Browser page displaying the catalog.
 * @param expected - Matching games in their expected display order.
 * @param total - Full catalog size before filtering, including any test-scoped changes.
 */
async function expectVisibleGames(page: Page, expected: Game[], total: number): Promise<void> {
  const cards = page.locator('[data-testid="game-card"]:visible');
  await expect(cards.getByTestId('game-title')).toHaveText(expected.map((game) => game.title));
  await expect.poll(() => cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-game-id')),
  )).toEqual(expected.map((game) => String(game.id)));
  await expect(page.getByTestId('filter-results')).toHaveText(`${expected.length} of ${total} games shown`);
}

test.describe('Game catalog filters', () => {
  let catalog: Game[];
  let categoryIds: number[];
  let publisherId: number;

  test.beforeAll(async () => {
    catalog = await getAllGames(getDatabase());
    categoryIds = [...new Set(catalog.flatMap((game) => game.category ? [game.category.id] : []))];
    const publisher = catalog[0]?.publisher;
    expect(categoryIds.length).toBeGreaterThan(1);
    if (!publisher) throw new Error('Filtering tests require a seeded publisher');
    publisherId = publisher.id;
  });

  test('filters by any selected category and combines with a publisher', async ({ page }) => {
    await page.goto('/');
    await expectVisibleGames(page, catalog, catalog.length);

    await test.step('Select one category, then add a second category', async () => {
      await page.getByTestId(`category-filter-${categoryIds[0]}`).check();
      await expectVisibleGames(page, catalog.filter((game) => game.category?.id === categoryIds[0]), catalog.length);
      await page.getByTestId(`category-filter-${categoryIds[1]}`).check();
      await expectVisibleGames(page, catalog.filter((game) => categoryIds.slice(0, 2).includes(game.category?.id ?? -1)), catalog.length);
    });

    await test.step('Combine categories with a publisher', async () => {
      await page.getByLabel('Publisher', { exact: true }).selectOption(String(publisherId));
      await expectVisibleGames(page, catalog.filter((game) =>
        categoryIds.slice(0, 2).includes(game.category?.id ?? -1) && game.publisher?.id === publisherId,
      ), catalog.length);
    });

    await test.step('Clear both filters and restore the catalog', async () => {
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect(page.getByLabel('Publisher', { exact: true })).toHaveValue('');
      await expect(page.locator('input[name="category"]:checked')).toHaveCount(0);
      await expectVisibleGames(page, catalog, catalog.length);
    });
  });

  test('filters by publisher alone and navigates to a matching game', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Publisher', { exact: true }).selectOption(String(publisherId));
    const expected = catalog.filter((game) => game.publisher?.id === publisherId);
    await expectVisibleGames(page, expected, catalog.length);
    await page.getByLabel('Publisher', { exact: true }).selectOption('');
    await expectVisibleGames(page, catalog, catalog.length);
    await page.getByLabel('Publisher', { exact: true }).selectOption(String(publisherId));
    await page.locator('[data-testid="game-card"]:visible').first().click();
    await expect(page).toHaveURL(`/game/${expected[0].id}`);
    await expect(page.getByTestId('game-details-title')).toHaveText(expected[0].title);
  });

  test('shows a no-match message and recovers when filters are cleared', async ({ page }) => {
    const categoryId = categoryIds[0];
    const remaining = catalog.filter((game) =>
      !(game.category?.id === categoryId && game.publisher?.id === publisherId),
    );
    // Simulate a sparse catalog without changing the shared seeded database.
    await page.route('http://localhost:4321/', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<a\b[^>]*data-testid="game-card"[^>]*>[\s\S]*?<\/a>/g,
        (card) => card.includes(`data-category-id="${categoryId}"`) && card.includes(`data-publisher-id="${publisherId}"`) ? '' : card,
      );
      await route.fulfill({ response, body });
    });
    await page.goto('/');
    await expectVisibleGames(page, remaining, remaining.length);
    await page.getByTestId(`category-filter-${categoryId}`).check();
    await page.getByLabel('Publisher', { exact: true }).selectOption(String(publisherId));
    await expectVisibleGames(page, [], remaining.length);
    await expect(page.getByTestId('no-matching-games')).toContainText('No games match your filters.');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expectVisibleGames(page, remaining, remaining.length);
    await expect(page.getByTestId('no-matching-games')).toBeHidden();
  });

  test('keeps the complete catalog usable without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('http://localhost:4321/');
      await expect(page.locator('[data-testid="game-card"]:visible')).toHaveCount(catalog.length);
      await expect(page.locator('#game-filters')).toBeHidden();
      await page.getByTestId('game-card').first().click();
      await expect(page.getByTestId('game-details-title')).toHaveText(catalog[0].title);
    } finally {
      await context.close();
    }
  });
});

test.describe('Game Listing and Navigation', () => {
  test('should display each game rating out of five on its card', async ({ page }) => {
    const games = await getAllGames(getDatabase());
    expect(games.length).toBeGreaterThan(0);

    await page.goto('/');
    await expect(page.getByTestId('game-card')).toHaveCount(games.length);

    for (const game of games) {
      const card = page.getByTestId('game-card').filter({
        has: page.getByRole('heading', { name: game.title, exact: true }),
      });
      await expect(card.getByTestId('game-rating')).toHaveText(
        game.starRating === null ? 'No rating yet' : `${game.starRating} / 5`,
      );
    }
  });

  test('should display games with titles on index page', async ({ page }) => {
    await test.step('Navigate to homepage', async () => {
      await page.goto('/');
    });

    await test.step('Verify games grid is visible', async () => {
      const gamesGrid = page.getByTestId('games-grid');
      await expect(gamesGrid).toBeVisible();
    });

    await test.step('Verify game cards are displayed', async () => {
      const gameCards = page.getByTestId('game-card');
      await expect(gameCards.first()).toBeVisible();
      expect(await gameCards.count()).toBeGreaterThan(0);
    });

    await test.step('Verify game cards have titles with content', async () => {
      const gameCards = page.getByTestId('game-card');
      await expect(gameCards.first().getByTestId('game-title')).toBeVisible();
      await expect(gameCards.first().getByTestId('game-title')).not.toBeEmpty();
    });
  });

  test('should navigate to correct game details page when clicking on a game', async ({ page }) => {
    let gameId: string | null;
    let gameTitle: string | null;

    await test.step('Navigate to homepage and wait for games to load', async () => {
      await page.goto('/');
      const gamesGrid = page.getByTestId('games-grid');
      await expect(gamesGrid).toBeVisible();
    });

    await test.step('Get first game information and click it', async () => {
      const firstGameCard = page.getByTestId('game-card').first();
      gameId = await firstGameCard.getAttribute('data-game-id');
      gameTitle = await firstGameCard.getAttribute('data-game-title');
      await firstGameCard.click();
    });

    await test.step('Verify navigation to game details page', async () => {
      await expect(page).toHaveURL(`/game/${gameId}`);
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify game title matches clicked game', async () => {
      if (gameTitle) {
        await expect(page.getByTestId('game-details-title')).toHaveText(gameTitle);
      }
    });
  });

  test('should display game details with all required information', async ({ page }) => {
    await test.step('Navigate to specific game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify game title is displayed', async () => {
      const gameTitle = page.getByTestId('game-details-title');
      await expect(gameTitle).toBeVisible();
      await expect(gameTitle).not.toBeEmpty();
    });

    await test.step('Verify game description is displayed', async () => {
      const gameDescription = page.getByTestId('game-details-description');
      await expect(gameDescription).toBeVisible();
      await expect(gameDescription).not.toBeEmpty();
    });

    await test.step('Verify publisher or category information is present', async () => {
      const publisherExists = await page.getByTestId('game-details-publisher').isVisible();
      const categoryExists = await page.getByTestId('game-details-category').isVisible();
      expect(publisherExists || categoryExists).toBeTruthy();

      if (publisherExists) {
        await expect(page.getByTestId('game-details-publisher')).not.toBeEmpty();
      }

      if (categoryExists) {
        await expect(page.getByTestId('game-details-category')).not.toBeEmpty();
      }
    });
  });

  test('should display a button to back the game', async ({ page }) => {
    await test.step('Navigate to game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Verify back game button is visible and enabled', async () => {
      const backButton = page.getByTestId('back-game-button');
      await expect(backButton).toBeVisible();
      await expect(backButton).toContainText('Support This Game');
      await expect(backButton).toBeEnabled();
    });
  });

  test('should be able to navigate back to home from game details', async ({ page }) => {
    await test.step('Navigate to game details page', async () => {
      await page.goto('/game/1');
      await expect(page.getByTestId('game-details')).toBeVisible();
    });

    await test.step('Click back to all games link', async () => {
      const backLink = page.getByRole('link', { name: /back to all games/i });
      await expect(backLink).toBeVisible();
      await backLink.click();
    });

    await test.step('Verify navigation back to homepage', async () => {
      await expect(page).toHaveURL('/');
      await expect(page.getByTestId('games-grid')).toBeVisible();
    });
  });

  test('should return a 404 page for a non-existent game', async ({ page }) => {
    let response: Response | null;

    await test.step('Navigate to non-existent game', async () => {
      response = await page.goto('/game/99999');
    });

    await test.step('Verify a branded 404 page is served', async () => {
      expect(response?.status()).toBe(404);
      await expect(page).toHaveTitle(/Page Not Found - Tailspin Toys/);
      await expect(page.getByTestId('not-found')).toBeVisible();
      await expect(page.getByTestId('not-found-heading')).not.toBeEmpty();
      await expect(page.getByTestId('not-found-home-link')).toBeVisible();
    });
  });
});
