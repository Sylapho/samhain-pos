import { IDBFactory } from 'fake-indexeddb'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CatalogSynchronization } from './CatalogSynchronization'
import { CatalogService } from '../../services/catalogService'
import { IndexedDbCatalogRepository } from '../../services/catalogRepository'
import { initialCategories } from '../../data/initialCategories'
import type { Product } from '../../types/catalog'
import { catalogStorage } from '../../native/catalogStorage'
import { sha256Hex } from '../../utils/integrity'

vi.mock('../../config/apiAuthRuntime', () => ({ apiAuthConfiguration: { status: 'configured' } }))
vi.mock('../../native/catalogStorage', () => ({
  catalogStorage: {
    isAndroidNative: () => true,
    managerLogin: vi.fn(),
    managerLogout: vi.fn().mockResolvedValue(undefined),
    managerStatus: vi.fn(),
    getPublicationScope: vi.fn(),
    publishCatalog: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  let connected = false
  vi.mocked(catalogStorage.managerStatus).mockImplementation(async () => ({
    authenticated: connected,
  }))
  vi.mocked(catalogStorage.managerLogin).mockImplementation(async () => {
    connected = true
    return { status: 'authenticated' }
  })
  vi.mocked(catalogStorage.managerLogout).mockImplementation(async () => {
    connected = false
  })
})

it('requires OIDC and an explicit publication, stages without activating and keeps the manager session', async () => {
  const product: Product = {
    id: 'fixture',
    name: 'Test',
    priceCents: 500,
    vatRate: 10,
    categoryId: 'menus',
    active: true,
    displayOrder: 0,
    requiresPreparation: false,
    availability: 'available',
    dataConfidence: 'confirmed',
  }
  const scope = { organizationId: 'test-org', festivalId: 'test-festival' }
  const payload = JSON.stringify({
    ...scope,
    id: 'publication',
    schemaVersion: 1,
    revision: 1,
    publishedAt: '2026-10-25T00:00:00Z',
    origin: 'api:manager',
    products: [product],
    categories: initialCategories,
  })
  vi.mocked(catalogStorage.getPublicationScope).mockResolvedValue(scope)
  vi.mocked(catalogStorage.publishCatalog).mockResolvedValue({
    version: { payload, sha256: sha256Hex(payload) },
  })
  const service = new CatalogService(
    new IndexedDbCatalogRepository(new IDBFactory(), 'catalog-ui-test'),
    [product],
  )
  await service.loadCatalog()
  const apply = vi.fn()
  const view = render(
    <CatalogSynchronization
      service={service}
      onApply={apply}
      onBusyChanged={() => {}}
      products={[product]}
      categories={[...initialCategories]}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Proposer une publication centrale' }))
  const submit = screen.getByRole('button', {
    name: 'Publier les modifications sur toutes les tablettes',
  })
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Se connecter pour publier' }))
  await waitFor(() => expect(submit).toBeEnabled())
  expect(catalogStorage.publishCatalog).not.toHaveBeenCalled()
  fireEvent.click(submit)
  await screen.findByText(/Révision 1 téléchargée/)
  expect(catalogStorage.publishCatalog).toHaveBeenCalledWith({
    body: {
      ...scope,
      schemaVersion: 1,
      expectedRevision: 0,
      products: expect.any(Array),
      categories: expect.any(Array),
    },
  })
  expect(catalogStorage.managerLogout).not.toHaveBeenCalled()
  expect((await service.distribution.status()).active).toBeUndefined()
  expect((await service.distribution.status()).pending).toBeDefined()
  expect(apply).not.toHaveBeenCalled()
  view.unmount()
  expect(catalogStorage.managerLogout).not.toHaveBeenCalled()
})

it('restores the native session, keeps it when closing publication, and allows explicit logout', async () => {
  let connected = true
  vi.mocked(catalogStorage.managerStatus).mockImplementation(async () => ({
    authenticated: connected,
  }))
  vi.mocked(catalogStorage.managerLogout).mockImplementation(async () => {
    connected = false
  })
  const service = new CatalogService(
    new IndexedDbCatalogRepository(new IDBFactory(), 'catalog-ui-restore'),
    [],
  )
  await service.loadCatalog()
  const props = {
    service,
    onApply: vi.fn(),
    onBusyChanged: vi.fn(),
    products: [],
    categories: [...initialCategories],
  }
  const view = render(<CatalogSynchronization {...props} />)
  await screen.findByRole('button', { name: 'Déconnecter le compte' })
  fireEvent.click(screen.getByRole('button', { name: 'Proposer une publication centrale' }))
  expect(
    screen.getByRole('button', { name: 'Publier les modifications sur toutes les tablettes' }),
  ).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Proposer une publication centrale' }))
  expect(catalogStorage.managerLogout).not.toHaveBeenCalled()
  view.unmount()
  render(<CatalogSynchronization {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Déconnecter le compte' }))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Déconnecter le compte' })).not.toBeInTheDocument(),
  )
  expect(catalogStorage.managerLogout).toHaveBeenCalledOnce()
  expect(catalogStorage.managerLogin).not.toHaveBeenCalled()
})
