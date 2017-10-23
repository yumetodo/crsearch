import {Result} from './result'
import {IndexID} from './index-id'

class Index {
  constructor(id, json) {
    this.id = id
    this.page_id = json.page_id

    // cache
    this.id_cache = this.join()
  }

  type() {
    return this.id.type
  }

  join_html() {
    return this.id.join_html()
  }

  join() {
    return this.id.join()
  }

  static ambgMatch(idx, q) {
    if ([Result.ARTICLE, Result.META].includes(idx.id.type)) {
      return idx.id_cache.toLowerCase().includes(q.toLowerCase())
    }

    return idx.id_cache.includes(q)
  }
}

export {Index}
