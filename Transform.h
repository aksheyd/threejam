#ifndef TRANSFORM_H
#define TRANSFORM_H

#include <iostream>
#include "./Bin/Include/glm/glm.hpp"
#include "./Bin/Include/glm/gtc/type_ptr.hpp"
#include "Component.h"
#include "GameObject.h"

class Transform : public Component
{
	
public:
	// FIXME: are transforms trees?
	//Transform* parent;
	//GameObject* gameObject;
	glm::vec3 position;

	// Construct Transform() with identity coordinates or with an init position
	Transform() : position(glm::vec3(0.0f, 0.0f, 0.0f)), Component("Transform") { }
	Transform(const glm::vec3& init_position) : position(init_position), Component("Transform") { }

	//void SetPosition(const glm::vec3& new_position) 
	//{
	//	position = new_position;
	//}

	//glm::vec3 GetPosition() {
	//	return position;
	//}
};

#endif
