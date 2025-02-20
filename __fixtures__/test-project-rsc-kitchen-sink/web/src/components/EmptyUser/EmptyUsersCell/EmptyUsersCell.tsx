'use client'

import type { FindEmptyUsers, FindEmptyUsersVariables } from 'types/graphql'

// TODO (RSC): Use Link from '@redwoodjs/router'
// import { Link, routes } from '@redwoodjs/router'
import { routes } from '@redwoodjs/router'
import type {
  CellSuccessProps,
  CellFailureProps,
  TypedDocumentNode,
} from '@redwoodjs/web'

import EmptyUsers from 'src/components/EmptyUser/EmptyUsers'

const Link = (props: any) => {
  return <a href={props.to}>{props.children}</a>
}

export const QUERY: TypedDocumentNode<FindEmptyUsers, FindEmptyUsersVariables> =
  gql`
    query FindEmptyUsers {
      emptyUsers {
        id
        email
        name
      }
    }
  `

export const Loading = () => <div>Loading...</div>

export const Empty = () => {
  return (
    <div className="rw-text-center">
      No emptyUsers yet.{' '}
      <Link to={routes.newEmptyUser()} className="rw-link">
        Create one?
      </Link>
    </div>
  )
}

export const Failure = ({ error }: CellFailureProps<FindEmptyUsers>) => (
  <div className="rw-cell-error">{error?.message}</div>
)

export const Success = ({
  emptyUsers,
}: CellSuccessProps<FindEmptyUsers, FindEmptyUsersVariables>) => {
  return <EmptyUsers emptyUsers={emptyUsers} />
}
