import { Button } from '../../components/ui/Button'
import type { ProductOption, ProductOptionGroup } from '../../types/catalog'

type Props = {
  groups: ProductOptionGroup[]
  optionPrices: Record<string, string>
  onChange: (groups: ProductOptionGroup[], optionPrices: Record<string, string>) => void
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = [...items]
  const other = index + direction
  if (other < 0 || other >= next.length) return next
  ;[next[index], next[other]] = [next[other]!, next[index]!]
  return next
}

const inputClass = 'min-h-11 w-full rounded-[8px] border border-stone-400 bg-white px-3'

export function MenuCompositionEditor({ groups, optionPrices, onChange }: Props) {
  const changeGroup = (index: number, group: ProductOptionGroup) =>
    onChange(
      groups.map((current, candidate) => (candidate === index ? group : current)),
      optionPrices,
    )

  const changeOption = (groupIndex: number, optionIndex: number, option: ProductOption) => {
    const group = groups[groupIndex]!
    changeGroup(groupIndex, {
      ...group,
      options: group.options.map((current, candidate) =>
        candidate === optionIndex ? option : current,
      ),
    })
  }

  return (
    <section
      className="mt-5 border-t border-stone-300 pt-4"
      aria-labelledby="menu-composition-title"
    >
      <h4 id="menu-composition-title" className="text-xl font-black">
        Composition et choix du menu
      </h4>
      <p className="mt-1 text-sm font-semibold text-stone-700">
        Configurez les groupes et les choix proposés lors de la vente.
      </p>
      <div className="mt-4 space-y-5">
        {groups.map((group, groupIndex) => (
          <fieldset key={group.id} className="border-t-2 border-stone-300 pt-4">
            <legend className="font-black">Groupe {groupIndex + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="font-bold">
                Nom du groupe
                <input
                  className={inputClass}
                  value={group.name}
                  onChange={(event) =>
                    changeGroup(groupIndex, { ...group, name: event.target.value })
                  }
                />
              </label>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  aria-label={`Monter le groupe ${group.name || groupIndex + 1}`}
                  disabled={groupIndex === 0}
                  onClick={() => onChange(move(groups, groupIndex, -1), optionPrices)}
                >
                  Monter
                </Button>
                <Button
                  aria-label={`Descendre le groupe ${group.name || groupIndex + 1}`}
                  disabled={groupIndex === groups.length - 1}
                  onClick={() => onChange(move(groups, groupIndex, 1), optionPrices)}
                >
                  Descendre
                </Button>
                <Button
                  variant="danger"
                  aria-label={`Supprimer le groupe ${group.name || groupIndex + 1}`}
                  onClick={() =>
                    onChange(
                      groups.filter((_, index) => index !== groupIndex),
                      optionPrices,
                    )
                  }
                >
                  Supprimer
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              <label className="flex min-h-11 items-center gap-2 font-bold">
                <input
                  type="checkbox"
                  className="size-6"
                  checked={group.required}
                  onChange={(event) =>
                    changeGroup(groupIndex, { ...group, required: event.target.checked })
                  }
                />
                Obligatoire
              </label>
              <label className="font-bold">
                Sélection
                <select
                  className="ml-2 min-h-11 rounded-[8px] border border-stone-400 bg-white px-2"
                  value={group.type}
                  onChange={(event) => {
                    const type = event.target.value as ProductOptionGroup['type']
                    changeGroup(groupIndex, { ...group, type })
                  }}
                >
                  <option value="single">Un seul choix</option>
                  <option value="multiple">Plusieurs choix</option>
                </select>
              </label>
            </div>
            <div className="mt-3 space-y-3">
              {group.options.map((option, optionIndex) => (
                <div key={option.id} className="border-l-4 border-stone-300 pl-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_130px]">
                    <label className="font-bold">
                      Nom du choix {optionIndex + 1}
                      <input
                        className={inputClass}
                        value={option.name}
                        onChange={(event) =>
                          changeOption(groupIndex, optionIndex, {
                            ...option,
                            name: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="font-bold">
                      Supplément (€)
                      <input
                        className={inputClass}
                        inputMode="decimal"
                        value={optionPrices[`${group.id}:${option.id}`] ?? '0,00'}
                        onChange={(event) =>
                          onChange(groups, {
                            ...optionPrices,
                            [`${group.id}:${option.id}`]: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="mr-auto flex min-h-11 items-center gap-2 font-bold">
                      <input
                        type={group.type === 'single' ? 'radio' : 'checkbox'}
                        name={group.type === 'single' ? `default-${group.id}` : undefined}
                        className="size-6"
                        checked={Boolean(option.default)}
                        onChange={(event) => {
                          if (group.type === 'single') {
                            changeGroup(groupIndex, {
                              ...group,
                              options: group.options.map((current) => ({
                                ...current,
                                default: current.id === option.id,
                              })),
                            })
                          } else
                            changeOption(groupIndex, optionIndex, {
                              ...option,
                              default: event.target.checked,
                            })
                        }}
                      />
                      Par défaut
                    </label>
                    <Button
                      aria-label={`Monter le choix ${option.name || optionIndex + 1}`}
                      disabled={optionIndex === 0}
                      onClick={() =>
                        changeGroup(groupIndex, {
                          ...group,
                          options: move(group.options, optionIndex, -1),
                        })
                      }
                    >
                      Monter
                    </Button>
                    <Button
                      aria-label={`Descendre le choix ${option.name || optionIndex + 1}`}
                      disabled={optionIndex === group.options.length - 1}
                      onClick={() =>
                        changeGroup(groupIndex, {
                          ...group,
                          options: move(group.options, optionIndex, 1),
                        })
                      }
                    >
                      Descendre
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Supprimer le choix ${option.name || optionIndex + 1}`}
                      onClick={() =>
                        changeGroup(groupIndex, {
                          ...group,
                          options: group.options.filter((_, index) => index !== optionIndex),
                        })
                      }
                    >
                      Supprimer
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {group.type === 'single' && group.options.some((option) => option.default) ? (
              <Button
                className="mt-3"
                onClick={() =>
                  changeGroup(groupIndex, {
                    ...group,
                    options: group.options.map((option) => ({ ...option, default: false })),
                  })
                }
              >
                Aucun choix par défaut
              </Button>
            ) : null}
            <Button
              className="mt-3"
              onClick={() => {
                const id = globalThis.crypto.randomUUID()
                onChange(
                  groups.map((current, index) =>
                    index === groupIndex
                      ? {
                          ...group,
                          options: [...group.options, { id, name: '', priceDeltaCents: 0 }],
                        }
                      : current,
                  ),
                  { ...optionPrices, [`${group.id}:${id}`]: '0,00' },
                )
              }}
            >
              Ajouter une option
            </Button>
          </fieldset>
        ))}
      </div>
      <Button
        className="mt-4"
        onClick={() =>
          onChange(
            [
              ...groups,
              {
                id: globalThis.crypto.randomUUID(),
                name: '',
                type: 'single',
                required: true,
                options: [],
              },
            ],
            optionPrices,
          )
        }
      >
        Ajouter un groupe
      </Button>
    </section>
  )
}
