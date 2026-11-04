import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { Shell } from './shell'
import { HomePage } from './views/home'
import { OrganizationPage } from './views/organization'
import { RepositoryPage } from './views/repository'

const rootRoute = createRootRoute({ component: () => <Shell><Outlet /></Shell> })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage })
export const organizationRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/org/$login', component: OrganizationPage
})
export const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repo/$owner/$name', component: RepositoryPage
})
export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, organizationRoute, repositoryRoute]),
  history: createHashHistory(),
  defaultPreload: 'intent'
})
declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
